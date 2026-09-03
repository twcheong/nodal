from __future__ import annotations

import asyncio
import json
import time
from typing import Any

from mcp import ClientSession
from mcp.client.streamable_http import streamable_http_client

MCP_URL = "http://127.0.0.1:8188/mcp"
TERMINAL_STATUSES = {"succeeded", "failed", "cancelled"}

BASE_PROMPT = (
    "Change only the time of day and lighting while preserving the input composition, "
    "camera, character identity, exact face proportions, pose, gaze, expression, hairstyle, "
    "brown eyes, both silver hoop earrings, black hoodie, white inner shirt, concrete "
    "riverside railing, waterline, and distant streetlamp. Make the time unmistakably sunset "
    "during civil twilight: a restrained dusty-peach and soft amber glow across the lower sky, "
    "muted mauve and lavender-grey clouds, faded cool slate blue at the top, gentle warm rim "
    "light, and soft peach-gold reflections on the calm river. Natural understated sunset, "
    "lyrical intimate quiet longing, premium cinematic 3D anime realism, clean upper-left "
    "title-safe area."
)
CHANGED_PROMPT = BASE_PROMPT.replace("quiet longing", "tender longing")
NEGATIVE_PROMPT = (
    "night, dark blue monochrome, weak sunset, text, letters, logo, watermark, signature, "
    "bright saturated orange, intense red sky, fiery sunset, giant sun, lens flare, fantasy "
    "landscape, flowers, petals, stars, neon, crying, tears, frown, smile, different person, "
    "altered face, altered eye color, extra earrings, missing earrings, costume redesign, "
    "duplicate face, deformation"
)


def arguments(prompt: str, *, use_cache: bool) -> dict[str, Any]:
    return {
        "source": "asset:82944155f052e6e7726ebdffb78696d0",
        "prompt": prompt,
        "negative_prompt": NEGATIVE_PROMPT,
        "transformer": "z_image_bf16.safetensors",
        "text_encoder": "qwen_3_4b.safetensors",
        "vae": "ae.safetensors",
        "config_repo": "Tongyi-MAI/Z-Image",
        "width": 768,
        "height": 960,
        "strength": 0.3,
        "steps": 26,
        "guidance_scale": 4.0,
        "seed": 9032031,
        "use_cache": use_cache,
    }


async def wait_for_run(session: ClientSession, run_id: str) -> dict[str, Any]:
    while True:
        result = await session.call_tool("get_run", {"run_id": run_id})
        detail = result.structured_content
        if detail["status"] in TERMINAL_STATUSES:
            return detail
        await asyncio.sleep(0.1)


async def run_once(
    session: ClientSession,
    *,
    label: str,
    prompt: str,
    use_cache: bool,
) -> dict[str, Any]:
    started = time.perf_counter()
    created = await session.call_tool(
        "run_template_zimage_i2i",
        arguments(prompt, use_cache=use_cache),
    )
    if created.is_error:
        raise RuntimeError(created.structured_content)
    run_id = created.structured_content["run_id"]
    detail = await wait_for_run(session, run_id)
    client_elapsed_ms = round((time.perf_counter() - started) * 1000)
    record = {
        "label": label,
        "run_id": run_id,
        "status": detail["status"],
        "use_cache": detail["use_cache"],
        "server_elapsed_ms": detail["elapsed_ms"],
        "mcp_end_to_end_ms": client_elapsed_ms,
        "executed": detail["executed"],
        "cached": detail["cached"],
        "result": detail["results"],
    }
    print(json.dumps(record, ensure_ascii=False), flush=True)
    if detail["status"] != "succeeded":
        raise RuntimeError(detail)
    return record


async def main() -> None:
    assert BASE_PROMPT != CHANGED_PROMPT
    assert BASE_PROMPT.replace("quiet", "tender") == CHANGED_PROMPT

    async with (
        streamable_http_client(MCP_URL) as (read_stream, write_stream),
        ClientSession(read_stream, write_stream) as session,
    ):
        await session.initialize()
        catalog = await session.call_tool("list_templates", {})
        loaded = catalog.structured_content["loaded"]
        rejected = catalog.structured_content["rejected"]
        zimage = next(item for item in loaded if item["id"] == "zimage_i2i")
        cache_schema = zimage["input_schema"]["properties"].get("use_cache")
        print(
            json.dumps(
                {
                    "mcp": MCP_URL,
                    "loaded_templates": len(loaded),
                    "rejected": rejected,
                    "use_cache_schema": cache_schema,
                    "prompt_change": {"from": "quiet", "to": "tender"},
                },
                ensure_ascii=False,
            ),
            flush=True,
        )
        await run_once(
            session,
            label="1_cold_cache_on",
            prompt=BASE_PROMPT,
            use_cache=True,
        )
        await run_once(
            session,
            label="2_one_word_changed_cache_on",
            prompt=CHANGED_PROMPT,
            use_cache=True,
        )
        await run_once(
            session,
            label="3_same_changed_prompt_cache_off",
            prompt=CHANGED_PROMPT,
            use_cache=False,
        )


if __name__ == "__main__":
    asyncio.run(main())
