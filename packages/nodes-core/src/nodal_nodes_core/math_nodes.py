"""산술 노드 — M1 실행 엔진을 GPU 없이 검증하기 위한 최소 집합.

M1 완료 기준이 "산술 노드 10개짜리 그래프를 CLI 로 실행"이므로, 여기 있는
노드들은 엔진을 시험하는 것이 목적이지 그 자체로 쓸모 있는 도구가 아니다.

모든 `run` 은 `ctx` 를 받지 않는 평범한 함수다 — 엔진 없이 그대로 호출할 수
있다 (docs/design.md §4.2)::

    Add().run(3, 4).values == (7,)
"""

from __future__ import annotations

from nodal import Bool, Float, Int, NodeResult, Str, node

__all__ = [
    "Add",
    "Clamp",
    "Const",
    "Divide",
    "Format",
    "Multiply",
    "Negate",
    "Power",
    "Print",
    "Subtract",
    "Sum3",
]


@node(id="math.Const", title="Const", category="math", aliases=["상수", "const"])
class Const:
    """리터럴 정수 하나. 그래프의 입력 지점이다."""

    value: Int = Int(0)

    returns = {"value": Int}

    def run(self, value: int) -> NodeResult:
        return NodeResult(value)


@node(id="math.Add", title="Add", category="math", aliases=["더하기", "plus", "+"])
class Add:
    """a + b."""

    a: Int = Int(0)
    b: Int = Int(0)

    returns = {"sum": Int}

    def run(self, a: int, b: int) -> NodeResult:
        return NodeResult(a + b)


@node(id="math.Subtract", title="Subtract", category="math", aliases=["빼기", "minus", "-"])
class Subtract:
    """a - b."""

    a: Int = Int(0)
    b: Int = Int(0)

    returns = {"difference": Int}

    def run(self, a: int, b: int) -> NodeResult:
        return NodeResult(a - b)


@node(id="math.Multiply", title="Multiply", category="math", aliases=["곱하기", "times", "*"])
class Multiply:
    """a 곱하기 b."""

    a: Int = Int(1)
    b: Int = Int(1)

    returns = {"product": Int}

    def run(self, a: int, b: int) -> NodeResult:
        return NodeResult(a * b)


@node(id="math.Divide", title="Divide", category="math", aliases=["나누기", "/"])
class Divide:
    """a 나누기 b (실수). 0 으로 나누면 실패한다 — 어느 노드인지 엔진이 지목한다."""

    a: Float = Float(0.0)
    b: Float = Float(1.0)

    returns = {"quotient": Float}

    def run(self, a: float, b: float) -> NodeResult:
        if b == 0:
            raise ZeroDivisionError("0 으로 나눌 수 없다")
        return NodeResult(a / b)


@node(id="math.Negate", title="Negate", category="math", aliases=["부호 반전"])
class Negate:
    """-value."""

    value: Int = Int(0)

    returns = {"value": Int}

    def run(self, value: int) -> NodeResult:
        return NodeResult(-value)


@node(id="math.Power", title="Power", category="math", aliases=["거듭제곱", "pow"])
class Power:
    """base 의 exponent 제곱."""

    base: Int = Int(2)
    exponent: Int = Int(2, min=0, max=16)

    returns = {"value": Int}

    def run(self, base: int, exponent: int) -> NodeResult:
        return NodeResult(base**exponent)


@node(id="math.Clamp", title="Clamp", category="math", aliases=["범위 제한"])
class Clamp:
    """value 를 [low, high] 안으로 자른다."""

    value: Int = Int(0)
    low: Int = Int(0)
    high: Int = Int(100)

    returns = {"value": Int}

    def run(self, value: int, low: int, high: int) -> NodeResult:
        return NodeResult(max(low, min(high, value)))


@node(id="math.Sum3", title="Sum 3", category="math", aliases=["세 수 합"])
class Sum3:
    """세 입력을 더한다. 다이아몬드 의존성을 만들 때 쓴다."""

    a: Int = Int(0)
    b: Int = Int(0)
    c: Int = Int(0)

    returns = {"sum": Int}

    def run(self, a: int, b: int, c: int) -> NodeResult:
        return NodeResult(a + b + c)


@node(id="text.Format", title="Format", category="text", aliases=["문자열 조립"])
class Format:
    """`template` 의 `{value}` 를 값으로 채운다. INT → STRING 승격 확인용이다."""

    template: Str = Str("{value}")
    value: Int = Int(0)

    returns = {"text": Str}

    def run(self, template: str, value: int) -> NodeResult:
        return NodeResult(template.replace("{value}", str(value)))


@node(
    id="text.Print",
    title="Print",
    category="text",
    aliases=["출력", "print"],
    output_node=True,
)
class Print:
    """출력 노드. 값을 텍스트 배지로 넘긴다.

    `output_node=True` 라서 실행 선택 휴리스틱이 이 노드를 우선한다
    (design.md §1.1 ②). 프리뷰가 먼저 뜨는 체감이 여기서 나온다.
    """

    text: Str = Str("")
    enabled: Bool = Bool(True)

    returns = {"text": Str}

    def run(self, text: str, enabled: bool) -> NodeResult:
        shown = text if enabled else ""
        return NodeResult(shown, text=shown)
