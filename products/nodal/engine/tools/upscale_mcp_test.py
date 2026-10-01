"""Run the saved-video AI upscale MCP template, or resume observing a run."""

import argparse
import asyncio
import json
from pathlib import Path

from h3_mcp_test import payload
from mcp import ClientSession
from mcp.client.streamable_http import streamable_http_client


async def run(args):
    async with (
        streamable_http_client(args.url) as (read, write),
        ClientSession(read, write) as session,
    ):
        await session.initialize()
        args.output.mkdir(parents=True, exist_ok=True)
        if args.run_id:
            run_id = args.run_id
        else:
            arguments = dict(
                source=args.source,
                model_path=args.model_path,
                short_edge=args.short_edge,
                tile_size=args.tile_size,
            )
            created = payload(await session.call_tool("run_template_upscale_video", arguments))
            run_id = created["run_id"]
            receipt = dict(tool="run_template_upscale_video", arguments=arguments, **created)
            (args.output / "request.json").write_text(
                json.dumps(receipt, indent=2), encoding="utf-8"
            )
            print(json.dumps(receipt), flush=True)
        while True:
            detail = payload(await session.call_tool("get_run", {"run_id": run_id}))
            (args.output / "run.json").write_text(json.dumps(detail, indent=2), encoding="utf-8")
            print(json.dumps(detail), flush=True)
            if detail["status"] in ("succeeded", "failed", "cancelled"):
                if detail["status"] != "succeeded":
                    raise RuntimeError(f"Upscale execution ended: {detail}")
                return
            await asyncio.sleep(10)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--url", default="http://127.0.0.1:8190/mcp")
    parser.add_argument("--source", default="", help="Server-local H3 WebM path")
    parser.add_argument("--model-path", default="")
    parser.add_argument("--short-edge", choices=("720", "1080"), default="720")
    parser.add_argument("--tile-size", type=int, default=256)
    parser.add_argument("--run-id")
    parser.add_argument("--output", type=Path, default=Path("outputs/h3/upscale-test"))
    args = parser.parse_args()
    if not args.source and not args.run_id:
        parser.error("--source or --run-id is required")
    if args.source.startswith("asset:"):
        parser.error("MCP asset: is reserved for Image inputs; use the saved WebM path")
    asyncio.run(run(args))


if __name__ == "__main__":
    main()
