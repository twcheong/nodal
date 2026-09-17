"""Verify local MCP, thumbnail execution, asset retrieval and cache without GPU models."""

from __future__ import annotations

import argparse
import asyncio
import io
import json
from typing import Any
from urllib.parse import urlsplit

import httpx
from mcp import ClientSession
from mcp.client.streamable_http import streamable_http_client
from PIL import Image


def payload(result: Any) -> dict[str, Any]:
    if result.is_error or result.structured_content is None:
        raise RuntimeError(f"MCP call failed: {result}")
    return result.structured_content


async def thumbnail(session: ClientSession) -> dict[str, Any]:
    created = payload(
        await session.call_tool(
            "run_template_thumbnail",
            {"source": "examples/sample.png", "size": 128, "use_cache": True},
        )
    )
    run_id = created["run_id"]
    print(json.dumps({"submitted": run_id}), flush=True)
    try:
        async with asyncio.timeout(30):
            while True:
                detail = payload(await session.call_tool("get_run", {"run_id": run_id}))
                if detail["status"] == "succeeded":
                    return detail
                if detail["status"] in {"failed", "cancelled"}:
                    raise RuntimeError(json.dumps(detail, ensure_ascii=False))
                await asyncio.sleep(0.2)
    except TimeoutError:
        await session.call_tool("cancel_run", {"run_id": run_id})
        raise RuntimeError(f"Thumbnail timed out; cancellation requested: {run_id}") from None


async def run(url: str) -> None:
    parsed = urlsplit(url)
    if (
        parsed.scheme != "http"
        or parsed.hostname not in {"127.0.0.1", "localhost"}
        or parsed.username is not None
        or parsed.password is not None
        or parsed.path != "/mcp"
        or parsed.query
        or parsed.fragment
    ):
        raise ValueError("Use the local server URL: http://127.0.0.1:<port>/mcp")
    base = f"{parsed.scheme}://{parsed.netloc}"
    async with (
        streamable_http_client(url) as (read, write),
        ClientSession(read, write) as session,
        httpx.AsyncClient(base_url=base, timeout=10, trust_env=False) as client,
    ):
        await session.initialize()
        available = {item.name for item in (await session.list_tools()).tools}
        if "run_template_thumbnail" not in available:
            raise RuntimeError(
                "Missing thumbnail template; start with --templates examples/templates"
            )
        catalog = payload(await session.call_tool("list_templates", {}))
        print(
            json.dumps(
                {
                    "loaded": [item["id"] for item in catalog["loaded"]],
                    "rejected": catalog["rejected"],
                },
                ensure_ascii=False,
            ),
            flush=True,
        )
        for index in range(2):
            detail = await thumbnail(session)
            digest = detail["results"]["image"]["asset"]["hash"]
            response = await client.get(f"/api/assets/{digest}")
            response.raise_for_status()
            with Image.open(io.BytesIO(response.content)) as image:
                image.load()
                if image.format != "PNG" or image.size != (128, 128):
                    raise RuntimeError(f"Unexpected thumbnail: {image.format} {image.size}")
            if index == 1 and not detail["cached"]:
                raise RuntimeError("Repeated thumbnail did not report cache hits")
            print(json.dumps({"iteration": index + 1, **detail}, ensure_ascii=False), flush=True)
        print("PASS: MCP initialized; 2 thumbnails decoded at 128x128; cache hits observed.")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--url", default="http://127.0.0.1:8188/mcp")
    args = parser.parse_args()
    asyncio.run(run(args.url))


if __name__ == "__main__":
    main()
