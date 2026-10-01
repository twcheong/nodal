"""Run a small H3 test through the actual MCP HTTP endpoint and save its receipt."""

from __future__ import annotations

import argparse
import asyncio
import json
from pathlib import Path
from typing import Any

from mcp import ClientSession
from mcp.client.streamable_http import streamable_http_client


def payload(result: Any) -> dict[str, Any]:
    if result.is_error:
        raise RuntimeError(str(result))
    if result.structured_content is None:
        raise RuntimeError("MCP response is missing structured content")
    return result.structured_content


async def run(args: argparse.Namespace) -> None:
    async with (
        streamable_http_client(args.url) as (read, write),
        ClientSession(read, write) as session,
    ):
        initialized = await session.initialize()
        print(initialized.model_dump_json(), flush=True)
        tools = await session.list_tools()
        print(json.dumps({"tools": [item.name for item in tools.tools]}), flush=True)
        if args.list_only:
            return
        tool = "run_template_h3_image_video" if args.source else "run_template_h3_test_video"
        if tool not in {item.name for item in tools.tools}:
            raise RuntimeError(f"Missing MCP tool: {tool}")
        args.output.mkdir(parents=True, exist_ok=True)
        if args.run_id:
            run_id = args.run_id
        else:
            arguments = {
                "prompt": args.prompt,
                "seed": args.seed,
                "steps": args.steps,
                "width": args.width,
                "height": args.height,
            }
            if args.source:
                arguments["source"] = args.source
            created = payload(await session.call_tool(tool, arguments))
            run_id = created["run_id"]
            receipt = {"url": args.url, "tool": tool, "arguments": arguments, **created}
            (args.output / "request.json").write_text(
                json.dumps(receipt, indent=2), encoding="utf-8"
            )
            print(json.dumps(receipt), flush=True)
        while True:
            detail = payload(await session.call_tool("get_run", {"run_id": run_id}))
            print(json.dumps(detail, ensure_ascii=False), flush=True)
            (args.output / "run.json").write_text(
                json.dumps(detail, ensure_ascii=False, indent=2), encoding="utf-8"
            )
            if detail["status"] in {"succeeded", "failed", "cancelled"}:
                if detail["status"] != "succeeded":
                    raise RuntimeError(f"H3 execution ended: {detail['status']}")
                return
            await asyncio.sleep(20)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--url", default="http://127.0.0.1:8190/mcp")
    parser.add_argument("--list-only", action="store_true")
    parser.add_argument("--run-id")
    parser.add_argument(
        "--source", help="First-frame image path or asset:<hash>; enables image-to-video"
    )
    parser.add_argument("--seed", type=int, default=7)
    parser.add_argument("--steps", type=int, default=10)
    parser.add_argument("--width", type=int, default=512)
    parser.add_argument("--height", type=int, default=288)
    parser.add_argument("--output", type=Path, default=Path("outputs/h3/mcp-test"))
    parser.add_argument(
        "--prompt",
        default=(
            "A ginger cat sitting on a sunlit wooden windowsill slowly turns its head "
            "toward the camera and blinks. A gentle breeze moves the white curtain. "
            "Quiet birdsong outside. Realistic cinematic video, continuous single shot."
        ),
    )
    asyncio.run(run(parser.parse_args()))


if __name__ == "__main__":
    main()
