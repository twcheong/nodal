"""`ModelManager` — `nodal.ModelStore` 의 구현 (design.md §9.6).

책임 넷: 로딩 · 참조 카운팅 · LRU 언로드 · 오프로딩.

## ⚠️ ComfyUI 를 보지 않는다

VRAM 관리는 `AGENTS.md` 절대 규칙 1 이 가장 깨지기 쉬운 자리다. **1차는
`accelerate` 에 통째로 위임한다** — 느려도 된다는 것이 명시된 결정이다
(`roadmap.md` M4). 레이어 단위 부분 오프로드를 직접 구현하지 않으므로
`model_management.py` 를 참조할 이유 자체가 없다.

## 참조 카운팅은 수동이 아니다

`retain`/`release` 를 두지 않았다. 노드가 부르지 않기 때문이다 — 부르게 하면
한 번만 빠뜨려도 모델이 영원히 남거나 쓰는 중에 사라진다.

대신 **살아 있는 핸들을 약한 참조로 센다**. 실행 중에는 엔진의 결과 딕셔너리가
핸들을 붙들고 있으므로 참조 수가 0 이 아니고, 실행이 끝나 결과가 버려지면
자동으로 0 이 된다. 언로드는 참조 수가 0 인 항목만 고른다. 파이썬이 이미
정확하게 세고 있는 것을 다시 세지 않는다.

> ⚠️ 이 계산은 **실행 캐시가 핸들을 붙들지 않을 때만** 성립한다. 로더 노드가
> `cacheable=True` 이면 `LRUCache` 가 핸들을 강하게 들고 있어 참조 수가 영영
> 0 이 되지 않고 `capacity` 가 사실상 무한이 된다. 그래서 로더 노드들은
> `cacheable=False` 다 (`nodes.py`, `decisions.md` 2026-08-18).
"""

from __future__ import annotations

import logging
import threading
import weakref
from collections import OrderedDict
from collections.abc import Callable, Iterator
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, TypeVar

from nodal.models import DevicePlan, ModelLoadError

from .devices import DevicePolicy, empty_cache, free_memory, resolve_plan, to_torch_dtype
from .handles import Checkpoint, ClipHandle, ControlNetHandle, ModelHandle, VaeHandle

__all__ = ["DEFAULT_CAPACITY", "LOADERS", "ModelManager"]

_log = logging.getLogger("nodal.diffusion.models")

#: 체크포인트를 가리키는 뷰 핸들. `_track` 이 타입을 보존한다.
_HandleT = TypeVar("_HandleT", ModelHandle, ClipHandle, VaeHandle, ControlNetHandle)

#: 동시에 올려 두는 모델 수의 기본 상한. 넘으면 참조되지 않는 것부터 내린다.
DEFAULT_CAPACITY = 2

#: 인식하는 로더 이름. `ModelLoadError.expected` 가 이것을 싣는다.
LOADERS = ("diffusers.pretrained", "diffusers.single_file")

#: ControlNet 은 파이프라인이 아니라 컴포넌트 하나라 로더가 따로다. 같은 캐시에
#: 같은 상한으로 들어간다 — VRAM 을 차지하는 것은 마찬가지다.
CONTROLNET_LOADER = "diffusers.controlnet"

#: 단일 파일 체크포인트의 확장자.
SINGLE_FILE_SUFFIXES = (".safetensors", ".ckpt")


@dataclass
class _Entry:
    """캐시 항목 하나.

    `payload` 는 `Checkpoint`(파이프라인) 이거나 `ControlNetModel` 이다. 둘을
    한 딕셔너리에 담는 이유는 상한과 축출 순서를 **함께** 세야 하기 때문이다 —
    따로 세면 각각은 상한 안이지만 합쳐서 VRAM 을 넘길 수 있다.
    """

    payload: Any
    #: 밖으로 나간 핸들들. 약한 참조라 결과가 버려지면 저절로 빈다.
    handles: weakref.WeakSet[Any] = field(default_factory=weakref.WeakSet)

    @property
    def in_use(self) -> bool:
        """아직 누군가 이 항목의 핸들을 들고 있는가."""
        return len(self.handles) > 0

    @property
    def plan(self) -> DevicePlan | None:
        """축출 후 캐시를 비울 디바이스. 계획을 모르는 항목이면 `None`."""
        plan = getattr(self.payload, "plan", None)
        return plan if isinstance(plan, DevicePlan) else None


class ModelManager:
    """모델 로딩과 메모리 관리. `ctx.models` 가 이것이다.

    스레드 안전하다 — 엔진이 동기 노드를 `asyncio.to_thread` 로 돌리므로
    두 노드가 동시에 같은 체크포인트를 요청할 수 있다.

    Args:
        policy: 디바이스 정책. 없으면 `NODAL_DEVICE` 환경변수에서 읽는다.
        capacity: 동시에 올려 둘 체크포인트 수.
        models_root: 상대 경로 참조를 푸는 기준 디렉토리.
    """

    def __init__(
        self,
        *,
        policy: DevicePolicy | None = None,
        capacity: int = DEFAULT_CAPACITY,
        models_root: Path | None = None,
    ) -> None:
        self._policy = policy if policy is not None else DevicePolicy.from_env()
        self._capacity = max(1, capacity)
        self._models_root = models_root
        self._lock = threading.RLock()
        self._entries: OrderedDict[str, _Entry] = OrderedDict()
        self._plan: DevicePlan | None = None

    # ------------------------------------------------------------- ModelStore

    @property
    def plan(self) -> DevicePlan:
        """이 실행의 디바이스 계획. 처음 물어볼 때 한 번 해석하고 고정한다.

        고정하는 이유: 실행 도중에 바뀌면 같은 그래프의 노드들이 서로 다른
        dtype 으로 돌게 된다. 그러면 어디서 어긋났는지 추적할 수 없다.
        """
        with self._lock:
            if self._plan is None:
                self._plan = resolve_plan(self._policy)
                _log.info("디바이스 계획: %s", _describe(self._plan))
            return self._plan

    def load(self, ref: str, *, loader: str = "diffusers.pretrained") -> ModelHandle:
        """체크포인트를 로드하고 `Model` 뷰를 돌려준다.

        같은 `(ref, loader)` 는 한 번만 로드된다. `clip()` · `vae()` 로 같은
        체크포인트의 다른 뷰를 얻는다.
        """
        handle = ModelHandle(self._checkpoint(ref, loader))
        return self._track(handle)

    # ------------------------------------------------------- 같은 체크포인트의 뷰

    def clip(self, ref: str, *, loader: str = "diffusers.pretrained") -> ClipHandle:
        return self._track(ClipHandle(self._checkpoint(ref, loader)))

    def vae(self, ref: str, *, loader: str = "diffusers.pretrained") -> VaeHandle:
        return self._track(VaeHandle(self._checkpoint(ref, loader)))

    # ----------------------------------------------------------- ControlNet

    def controlnet(self, ref: str, *, target: str | None = None) -> ControlNetHandle:
        """ControlNet 하나를 로드하고 핸들을 돌려준다.

        체크포인트와 **같은 캐시·같은 상한**을 쓴다. 노드가 매번 로드하면
        (`ControlNetLoader` 는 `cacheable=False` 다) 실행마다 디스크를 다시 읽는다.

        Args:
            ref: 사용자가 고른 이름. 캐시 키이자 에러 메시지에 실리는 것.
            target: 실제로 열 경로. 없으면 `ref` 를 그대로 연다.
        """
        model = self._entry(
            _key(ref, CONTROLNET_LOADER),
            lambda: self._load_controlnet(ref, target if target is not None else ref),
        )
        return self._track(ControlNetHandle(model=model, ref=ref, plan=self.plan))

    # ------------------------------------------------------------------ 내부

    def _track(self, handle: _HandleT) -> _HandleT:
        """핸들을 항목의 약한 참조 집합에 등록한다 — 이것이 참조 카운팅이다."""
        if isinstance(handle, ControlNetHandle):
            key = _key(handle.ref, CONTROLNET_LOADER)
        else:
            key = _key(handle.checkpoint.ref, handle.checkpoint.loader)
        with self._lock:
            entry = self._entries.get(key)
            if entry is not None:
                entry.handles.add(handle)
        return handle

    def _checkpoint(self, ref: str, loader: str) -> Checkpoint:
        if loader not in LOADERS:
            raise ModelLoadError(
                ref,
                loader=loader,
                reason="알 수 없는 로더",
                expected=LOADERS,
            )
        checkpoint = self._entry(_key(ref, loader), lambda: self._load_checkpoint(ref, loader))
        assert isinstance(checkpoint, Checkpoint)
        return checkpoint

    def _entry(self, key: str, build: Callable[[], Any]) -> Any:
        """캐시에서 꺼내거나 만들어 넣는다. 상한 검사까지 여기서 한다."""
        with self._lock:
            entry = self._entries.get(key)
            if entry is not None:
                self._entries.move_to_end(key)  # LRU 갱신
                return entry.payload

        # 로딩은 오래 걸린다. 락을 쥔 채로 하면 다른 노드가 전부 막힌다.
        payload = build()

        with self._lock:
            existing = self._entries.get(key)
            if existing is not None:
                # 다른 스레드가 먼저 끝냈다. 방금 만든 것을 버린다 — 같은 것이
                # 두 벌 올라가 있는 상태가 가장 나쁘다.
                return existing.payload
            self._entries[key] = _Entry(payload)
            self._entries.move_to_end(key)
            # 방금 넣은 것은 후보에서 뺀다 — 아직 핸들이 나가지 않아 "사용 안 함"
            # 으로 보이므로, 보호하지 않으면 로드하자마자 자기 자신을 내린다.
            self._evict_if_needed(protect=key)
        return payload

    def _load_controlnet(self, ref: str, target: str) -> Any:
        from diffusers import ControlNetModel

        plan = self.plan
        dtype = to_torch_dtype(plan.dtype)
        try:
            if target.endswith(SINGLE_FILE_SUFFIXES):
                model = ControlNetModel.from_single_file(target, torch_dtype=dtype)
            else:
                # diffusers 는 from_pretrained 에 타입을 붙이지 않는다.
                model = ControlNetModel.from_pretrained(  # type: ignore[no-untyped-call]
                    target, torch_dtype=dtype
                )
        except Exception as exc:
            raise ModelLoadError(
                ref,
                loader=CONTROLNET_LOADER,
                reason=str(exc),
                expected=(CONTROLNET_LOADER,),
                evidence=(f"열려던 것: {target}",),
            ) from exc

        model.to(str(plan.compute))
        _log.info("로드: %s (ControlNet) → %s", ref, plan.compute)
        return model

    def _load_checkpoint(self, ref: str, loader: str) -> Checkpoint:
        plan = self.plan
        torch_dtype = to_torch_dtype(plan.dtype)
        target = self._resolve_ref(ref, loader)

        try:
            pipe = _call_loader(loader, target, torch_dtype)
        except ModelLoadError:
            raise
        except Exception as exc:
            raise _load_error(ref, loader, target, exc) from exc

        pipe.set_progress_bar_config(disable=True)
        architecture = type(pipe).__name__
        self._place(pipe, plan)
        _log.info("로드: %s (%s) → %s", ref, architecture, plan.compute)
        return Checkpoint(ref=ref, loader=loader, pipe=pipe, plan=plan, architecture=architecture)

    def _resolve_ref(self, ref: str, loader: str) -> str:
        """상대 참조를 모델 루트 기준으로 푼다. 절대 경로·저장소 ID 는 그대로."""
        if self._models_root is None:
            return ref
        candidate = Path(ref)
        if candidate.is_absolute():
            return ref
        subdir = "checkpoints"
        resolved = self._models_root / subdir / candidate
        return str(resolved) if resolved.exists() else ref

    def _place(self, pipe: Any, plan: DevicePlan) -> None:
        """파이프라인을 디바이스에 올린다. 오프로드는 `accelerate` 에 맡긴다.

        `enable_model_cpu_offload` 는 컴포넌트 단위로 필요할 때만 GPU 로 올리고
        끝나면 내린다. 레이어 단위 부분 오프로드는 더 빠르지만 직접 구현해야
        하고, 그것이 정확히 `AGENTS.md` 절대 규칙 1 이 경고하는 구간이다.
        1차는 느려도 위임한다.
        """
        if not plan.offloading:
            pipe.to(str(plan.compute))
            return

        enable = getattr(pipe, "enable_model_cpu_offload", None)
        if enable is None:
            _log.warning(
                "%s 는 accelerate 오프로드를 지원하지 않는다. 통째로 올린다.",
                type(pipe).__name__,
            )
            pipe.to(str(plan.compute))
            return
        enable(device=str(plan.compute))

    def _evict_if_needed(self, *, protect: str | None = None) -> None:
        """상한을 넘으면 **참조되지 않는** 항목부터 내린다. 락을 쥔 채로 부른다.

        `protect` 는 방금 로드해 아직 핸들이 나가지 않은 항목이다. 보호하지
        않으면 참조 수가 0 이라 곧바로 자기 자신이 희생자가 된다.
        """
        while len(self._entries) > self._capacity:
            victim = next(
                (k for k, e in self._entries.items() if not e.in_use and k != protect), None
            )
            if victim is None:
                # 전부 사용 중이다. 내리면 실행 중인 그래프가 깨지므로 넘긴다.
                _log.debug(
                    "모델 %d개가 전부 사용 중이라 언로드하지 않는다 (상한 %d)",
                    len(self._entries),
                    self._capacity,
                )
                return
            self._unload(victim)

    def _unload(self, key: str) -> None:
        entry = self._entries.pop(key)
        plan = entry.plan
        _log.info("언로드: %s", key)
        del entry
        if plan is not None:
            empty_cache(plan.compute)

    # ------------------------------------------------------------- 진단용 표면

    def loaded(self) -> tuple[str, ...]:
        """올라와 있는 모델 키. LRU 순서(오래된 것부터)다."""
        with self._lock:
            return tuple(self._entries)

    def in_use(self) -> tuple[str, ...]:
        """아직 핸들이 살아 있는 모델 키."""
        with self._lock:
            return tuple(k for k, e in self._entries.items() if e.in_use)

    def free_bytes(self) -> int | None:
        """`compute` 디바이스의 여유 바이트. 물어볼 수 없는 백엔드면 `None`."""
        return free_memory(self.plan.compute)

    def unload_all(self) -> None:
        """전부 내린다. 서버 종료와 테스트가 쓴다."""
        with self._lock:
            for key in list(self._entries):
                self._unload(key)

    def __iter__(self) -> Iterator[str]:
        return iter(self.loaded())


# ---------------------------------------------------------------------- 헬퍼


def _key(ref: str, loader: str) -> str:
    return f"{loader}\x1f{ref}"


def _describe(plan: DevicePlan) -> str:
    where = f"compute={plan.compute} dtype={plan.dtype}"
    return f"{where} offload={plan.offload}" if plan.offloading else f"{where} offload=없음"


def _call_loader(loader: str, target: str, torch_dtype: Any) -> Any:
    from diffusers import DiffusionPipeline

    if loader == "diffusers.single_file":
        return DiffusionPipeline.from_single_file(target, torch_dtype=torch_dtype)
    # diffusers 는 `from_pretrained` 에 타입을 붙이지 않는다. strict 모드가
    # untyped call 로 막으므로 여기서만 푼다 — 반환은 어차피 Any 다.
    return DiffusionPipeline.from_pretrained(  # type: ignore[no-untyped-call]
        target, torch_dtype=torch_dtype
    )


def _load_error(ref: str, loader: str, target: str, exc: Exception) -> ModelLoadError:
    """실패를 **무엇을 추론하려 했는지 말하는** 에러로 바꾼다 (design.md §9.2).

    `single_file` 은 파일 안의 텐서 키를 보고 아키텍처를 추론한다. 그 추론이
    깨졌을 때 "로드 실패" 라고만 하면 파일이 깨진 것인지, 지원하지 않는
    아키텍처인지, 컴포넌트가 빠진 것인지 구분할 수 없다.
    """
    if loader != "diffusers.single_file":
        return ModelLoadError(
            ref,
            loader=loader,
            reason=str(exc),
            expected=LOADERS,
            evidence=_pretrained_evidence(target),
        )

    return ModelLoadError(
        ref,
        loader=loader,
        reason=str(exc),
        inferred=None,
        expected=_known_architectures(),
        evidence=_single_file_evidence(target),
    )


def _known_architectures() -> tuple[str, ...]:
    """`from_single_file` 이 인식하는 아키텍처. diffusers 에서 직접 읽는다.

    목록을 여기 적으면 diffusers 를 올릴 때마다 낡는다. 읽을 수 없으면 빈
    튜플이고, 그때 에러는 "이 로더가 아는 것" 줄을 생략한다 — 틀린 목록을
    보여주는 것보다 낫다.
    """
    from importlib import import_module

    try:
        module = import_module("diffusers.loaders.single_file_utils")
    except ImportError:
        return ()
    # 이름이 버전마다 다르다. 둘 다 없으면 빈 튜플이고, 그때 에러는 "이 로더가
    # 아는 것" 줄을 생략한다 — 틀린 목록을 보여주는 것보다 낫다.
    for name in ("SINGLE_FILE_CHECKPOINT_KEYS", "CHECKPOINT_KEY_NAMES"):
        keys = getattr(module, name, None)
        if keys:
            return tuple(sorted(keys))
    return ()


def _single_file_evidence(target: str) -> tuple[str, ...]:
    """파일에서 **실제로 본 것**. 사용자가 "이건 그 모델이 아니구나" 를 판단할 재료.

    safetensors 헤더만 읽는다 (mmap, 가중치는 안 읽는다). 최상위 키 접두사를
    빈도순으로 몇 개 보여주면 SD1.5 인지 SDXL 인지 아예 다른 것인지 대개 보인다.
    """
    path = Path(target)
    if not path.is_file():
        return (f"파일이 없다: {target}",)
    if path.suffix != ".safetensors":
        return (f"{path.suffix or '확장자 없음'} 파일 — 텐서 키를 읽지 않았다",)

    try:
        from safetensors import safe_open

        with safe_open(path, framework="pt") as handle:
            keys = list(handle.keys())
    except Exception as exc:  # pragma: no cover - 깨진 파일 경로
        return (f"텐서 키를 읽을 수 없다: {exc}",)

    if not keys:
        return ("텐서가 하나도 없다",)

    prefixes: dict[str, int] = {}
    for key in keys:
        head = key.split(".")[0]
        prefixes[head] = prefixes.get(head, 0) + 1
    top = sorted(prefixes.items(), key=lambda kv: -kv[1])[:5]
    listed = ", ".join(f"{name}.* ({count}개)" for name, count in top)
    return (f"텐서 {len(keys)}개", f"최상위 키: {listed}")


def _pretrained_evidence(target: str) -> tuple[str, ...]:
    """폴더 로더 실패의 근거. `model_index.json` 이 있는지가 핵심이다."""
    path = Path(target)
    if not path.exists():
        return (f"로컬 경로가 아니다 (저장소 ID 로 시도했다): {target}",)
    index = path / "model_index.json"
    if not index.is_file():
        found = ", ".join(sorted(p.name for p in path.iterdir())[:8]) or "(비어 있음)"
        return (
            "model_index.json 이 없다 — diffusers 폴더 포맷이 아니다",
            f"이 폴더에 있는 것: {found}",
            "단일 파일 체크포인트라면 loader='diffusers.single_file' 을 쓴다",
        )
    return (f"model_index.json 은 있다: {index}",)
