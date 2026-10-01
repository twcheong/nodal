import argparse
import asyncio
import json
import sys
import urllib.request
from pathlib import Path

from mcp import ClientSession
from mcp.client.streamable_http import streamable_http_client

ROOT = Path(__file__).parent
sys.stdout.reconfigure(encoding="utf-8")
URL = "http://127.0.0.1:8199"


async def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("action", choices=["inspect", "submit", "status"])
    parser.add_argument("--request")
    args = parser.parse_args()
    async with (
        streamable_http_client(URL + "/mcp") as (read, write),
        ClientSession(read, write) as session,
    ):
        init = await session.initialize()
        if args.action == "inspect":
            result = await session.list_tools()
            (ROOT / "mcp-tools.json").write_text(result.model_dump_json(indent=2), encoding="utf-8")
            print(init.model_dump_json())
            print(json.dumps([t.name for t in result.tools]))
            with urllib.request.urlopen(URL + "/api/nodes") as response:
                nodes = json.load(response)
            (ROOT / "nodes.json").write_text(
                json.dumps(nodes, ensure_ascii=False, indent=2), encoding="utf-8"
            )
            print(json.dumps(nodes, ensure_ascii=False))
        elif args.action == "submit":
            request_path = Path(args.request)
            request = json.loads(request_path.read_text(encoding="utf-8"))
            receipt_path = request_path.with_suffix(".receipt.json")
            if receipt_path.exists():
                raise RuntimeError("Receipt already exists; do not duplicate generation")
            result = await session.call_tool(request["tool"], request["arguments"])
            receipt_path.write_text(result.model_dump_json(indent=2), encoding="utf-8")
            print(result.model_dump_json())
        else:
            request_path = Path(args.request)
            receipt = json.loads(
                request_path.with_suffix(".receipt.json").read_text(encoding="utf-8")
            )
            data = receipt.get("structuredContent") or receipt.get("structured_content")
            result = await session.call_tool("get_run", {"run_id": data["run_id"]})
            request_path.with_suffix(".status.json").write_text(
                result.model_dump_json(indent=2), encoding="utf-8"
            )
            print(result.model_dump_json())


asyncio.run(main())
