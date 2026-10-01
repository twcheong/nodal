"""Generate the approved six Won comparisons via nodal MCP, preserving receipts."""

from __future__ import annotations

import argparse
import asyncio
import hashlib
import json
from pathlib import Path
from typing import Any

import httpx
from h3_compare_review import inspect
from h3_mcp_test import payload
from mcp import ClientSession
from mcp.client.streamable_http import streamable_http_client

ACTION = (
    "A single continuous full-body shot of Won, the stylized 3D male character. "
    "He stands in the same slightly spread-arm pose throughout, in a plain light gray studio. "
    "He gently turns his head about ten degrees toward the camera, pauses briefly, "
    "then slowly returns his head to its original three-quarter orientation by the end. "
    "Only subtle breathing accompanies this small movement. His feet stay planted. "
    "The camera is locked off, the framing and subject size stay constant, "
    "both shoes remain visible. "
    "Constant soft lighting. Preserve the same facial anatomy, almond-shaped eyes, nose, mouth, "
    "jawline, short black fringe, small hoop earrings, black hoodie, white undershirt, "
    "loose blue jeans and beige sneakers throughout the entire shot. "
    "One character only. Quiet room tone, no speech, no music."
)
PROMPTS = {
    "anchor": "The first and last frames show the same Won character and pose. " + ACTION,
    "reference": (
        "<Picture 1> is the identity, clothing, full-body proportions, pose and studio reference "
        "for Won. <Picture 2> is a close-up of the SAME Won's face, not a second person. "
        "Use both pictures to preserve his identity. " + ACTION
    ),
}


def save(path: Path, value: Any) -> None:
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding="utf-8")


async def run(args: argparse.Namespace) -> None:
    source = args.source.resolve()
    source_hash = hashlib.sha256(source.read_bytes()).hexdigest()
    args.output.mkdir(parents=True, exist_ok=True)
    async with (
        httpx.AsyncClient(base_url=args.url, timeout=60) as http,
        streamable_http_client(args.url + "/mcp") as (read, write),
        ClientSession(read, write) as session,
    ):
        await session.initialize()
        catalog = payload(await session.call_tool("list_templates", {}))
        save(args.output / "catalog.json", catalog)
        available = {item.name for item in (await session.list_tools()).tools}
        for mode in ("anchor", "reference"):
            if f"run_template_h3_compare_{mode}" not in available:
                raise RuntimeError(f"Comparison template missing: {mode}")
        for seed in args.seeds:
            for mode in args.modes:
                folder = args.output / f"{mode}-{seed}"
                folder.mkdir(exist_ok=True)
                request_path = folder / "request.json"
                arguments = {
                    "source": str(source),
                    "prompt": PROMPTS[mode],
                    "seed": seed,
                    "steps": 16,
                    "width": 768,
                    "height": 1152,
                }
                if mode == "reference":
                    arguments.update(
                        reference_short_edge=768,
                        face_x=380,
                        face_y=10,
                        face_width=360,
                        face_height=340,
                    )
                tool = f"run_template_h3_compare_{mode}"
                if request_path.exists():
                    request = json.loads(request_path.read_text(encoding="utf-8"))
                    if request["arguments"] != arguments or request["source_sha256"] != source_hash:
                        raise RuntimeError(
                            f"Refusing to overwrite a different experiment: {folder}"
                        )
                    if (folder / "video.webm").is_file():
                        if not (folder / "qa.json").exists():
                            inspect(folder)
                        print(f"Already saved: {folder}", flush=True)
                        continue
                    run_id = request["run_id"]
                else:
                    # Reconcile interrupted submissions instead of duplicating them.
                    intent = folder / "intent.json"
                    if intent.exists():
                        raise RuntimeError(
                            f"Uncertain prior submission; inspect server runs: {folder}"
                        )
                    request = {
                        "url": args.url,
                        "tool": tool,
                        "arguments": arguments,
                        "source_sha256": source_hash,
                        "model_revision": "1a0ef5e65b639e84af81d883817968532180e9c7",
                    }
                    save(intent, request)
                    created = payload(await session.call_tool(tool, arguments))
                    request.update(created)
                    save(request_path, request)
                    run_id = request["run_id"]
                    print(json.dumps({"mode": mode, "seed": seed, **created}), flush=True)
                last = None
                while True:
                    detail = payload(await session.call_tool("get_run", {"run_id": run_id}))
                    save(folder / "run.json", detail)
                    if detail != last:
                        print(json.dumps({"mode": mode, "seed": seed, **detail}), flush=True)
                        last = detail
                    if detail["status"] in {"succeeded", "failed", "cancelled"}:
                        response = await http.get(f"/api/runs/{run_id}")
                        response.raise_for_status()
                        save(folder / "run-detail.json", response.json())
                        if detail["status"] != "succeeded":
                            raise RuntimeError(f"Generation ended {detail['status']}: {folder}")
                        asset = detail["results"]["video"]["asset"]
                        media = await http.get(f"/api/assets/{asset['hash']}")
                        media.raise_for_status()
                        (folder / "video.webm").write_bytes(media.content)
                        inspect(folder)
                        print(f"SAVED {folder / 'video.webm'}", flush=True)
                        break
                    await asyncio.sleep(30)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--url", default="http://127.0.0.1:8191")
    parser.add_argument(
        "--source", type=Path, default=Path("output/zimage-training/hwiwon-images/hwiwon (16).png")
    )
    parser.add_argument("--output", type=Path, default=Path("outputs/h3/won-method-comparison"))
    parser.add_argument("--seeds", nargs="+", type=int, default=[7, 19, 31])
    parser.add_argument("--modes", nargs="+", choices=list(PROMPTS), default=list(PROMPTS))
    asyncio.run(run(parser.parse_args()))


if __name__ == "__main__":
    main()
