# Hwiwon new-single promo image set

Built with the built-in ImageGen reference-edit workflow on 2026-09-01.

The four selected character references came from `C:/kohya_ss/dataset/10_hwiwon` and were used to preserve face shape, hairstyle, eye color, earrings, and outfit. The generated scene, lighting, pose, and atmosphere vary by direction.

The shared emotional direction was lyrical and aching but composed: soft distant gaze, closed relaxed mouth, no tears, no crying, and no exaggerated frown. Each image leaves negative space for deterministic title and release-copy typesetting after a final direction is selected.

No song title, release date, logo, or claim was invented. No readable text or watermark was requested in the generated pixels.

`05-quiet-riverside.png` is a focused refinement of the moonlit-flower direction. It removes the flower field, petals, and prominent moon, replacing them with a plain concrete riverside embankment, dark water, an overcast blue-hour sky, and one distant streetlamp reflection. The character identity, expression, wardrobe, framing, and title safe area remain the visual anchors.

## nodal MCP rerun — 2026-09-03

The source `05-quiet-riverside.png` was uploaded to the local nodal asset store as `asset:8b8cf10985bd7f3bb62c55c40d02a140`. Generation used only the nodal MCP tool `run_template_zimage_i2i` with local `z_image_bf16.safetensors`, `qwen_3_4b.safetensors`, and `ae.safetensors` weights at 768×960, 24 steps, guidance 4.0, and seed 9032026.

Run `287647ce72fc4cb6ab1920e17c5bf17b` used strength 0.32 and produced asset `7d933475b4b24e2d75e813a94a07a2a1`; it was rejected after visual inspection because of faint pseudo-text and excessive facial drift. Run `a0f55219e0b44257a9dca3e115f74067` lowered strength to 0.20 and produced the selected asset `82944155f052e6e7726ebdffb78696d0` without the pseudo-text artifact.

## nodal sunset refinement — 2026-09-03

The selected nodal riverside asset `82944155f052e6e7726ebdffb78696d0` was used as the source. Run `09a65976582240e79ace488c38387473` at strength 0.22 produced asset `695cf714262fa356a0830e95ff299203`; it preserved composition well but was rejected because the scene still read mainly as blue hour. Run `f8234bf8f55e42588a3b9f537d65822d` increased strength to 0.30 and produced selected asset `0c9d1aa2f7fb13a1725ceab5098a74a4`, adding a restrained peach horizon, mauve-grey clouds, warm rim light, and water reflections without text or decorative scenery.
