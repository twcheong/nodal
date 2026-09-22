"""Generate or edit through MCP, preserving request, receipt, result and PNG."""

from __future__ import annotations

import argparse
import asyncio
import json
from pathlib import Path
from typing import Any

import httpx
from mcp import ClientSession
from mcp.client.streamable_http import streamable_http_client


def payload(result: Any) -> dict[str, Any]:
    if result.is_error or result.structured_content is None:
        raise RuntimeError(str(result))
    return result.structured_content


async def run(args: argparse.Namespace) -> None:
    args.output.mkdir(parents=True, exist_ok=True)
    receipt = args.output / "request.json"
    async with (
        streamable_http_client(args.url) as (read, write),
        ClientSession(read, write) as session,
    ):
        await session.initialize()
        tools = await session.list_tools()
        (args.output / "tools.json").write_text(tools.model_dump_json(indent=2), encoding="utf-8")
        print(json.dumps({"tools": [t.name for t in tools.tools]}), flush=True)
        if args.list_only:
            return
        if args.resume:
            run_id = json.loads(receipt.read_text(encoding="utf-8"))["run_id"]
        else:
            if receipt.exists():
                raise RuntimeError("Receipt already exists. Use --resume or another --output.")
            arguments = dict(
                prompt=args.prompt,
                seed=args.seed,
                steps=args.steps,
                width=args.size,
                height=args.size,
                reference_resolution=args.size,
            )
            tool = "run_template_qwen21_generate"
            if args.source:
                arguments["reference_1"] = args.source
                tool = "run_template_qwen21_edit"
            result = payload(await session.call_tool(tool, arguments))
            run_id = result["run_id"]
            receipt.write_text(
                json.dumps(
                    {"url": args.url, "tool": tool, "arguments": arguments, **result}, indent=2
                ),
                encoding="utf-8",
            )
            print(json.dumps(result), flush=True)
        while True:
            detail = payload(await session.call_tool("get_run", {"run_id": run_id}))
            (args.output / "run.json").write_text(json.dumps(detail, indent=2), encoding="utf-8")
            print(json.dumps(detail), flush=True)
            if detail["status"] in {"failed", "cancelled"}:
                raise RuntimeError(f"Qwen run ended: {detail['status']}")
            if detail["status"] == "succeeded":
                asset = detail["results"]["image"]["asset"]
                async with httpx.AsyncClient() as client:
                    response = await client.get(
                        args.url.removesuffix("/mcp") + "/api/assets/" + asset["hash"]
                    )
                    response.raise_for_status()
                    (args.output / "image.png").write_bytes(response.content)
                return
            await asyncio.sleep(10)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--url", default="http://127.0.0.1:8210/mcp")
    parser.add_argument("--output", type=Path, default=Path("outputs/qwen21/smoke"))
    parser.add_argument("--source", help="Local image path or asset:<hash> for editing")
    parser.add_argument(
        "--prompt", default="A small blue ceramic teapot on a wooden table, daylight."
    )
    parser.add_argument("--size", type=int, default=512)
    parser.add_argument("--steps", type=int, default=20)
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument("--resume", action="store_true")
    parser.add_argument("--list-only", action="store_true")
    asyncio.run(run(parser.parse_args()))


if __name__ == "__main__":
    main()
