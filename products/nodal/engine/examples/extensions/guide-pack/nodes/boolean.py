from nodal import Bool, NodeResult, node


@node(
    id="guide.InvertBoolean",
    title="Invert Boolean",
    category="guide",
    aliases=["not", "반전"],
)
class InvertBoolean:
    """불리언 값을 뒤집는 최소 서드파티 노드 예제."""

    value: Bool = Bool(False, doc="뒤집을 값")

    returns = {"value": Bool}

    def run(self, value: bool) -> NodeResult:
        return NodeResult(not value)
