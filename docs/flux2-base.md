# FLUX.2 Klein Base comparison

The local split-component loader supports both distilled and Base Klein models.
It reads `is_distilled` from the selected pipeline configuration, using the
Diffusers default of `false` when the field is absent. The sampling node uses
guidance 1.0 for distilled models and 4.0 for Base models. The existing `steps`
input remains explicit: use 4 for the distilled model and 50 for the initial
Base comparison. Loading Base weights alone does not change the steps input.

Use matching transformer weights, configuration, tokenizer, scheduler, encoder,
and VAE. A local metadata directory is accepted by `config_repo`. The current
node does not expose arbitrary guidance values.

The September 3 comparison uses the official
[FLUX.2 Klein Base 4B model](https://huggingface.co/black-forest-labs/FLUX.2-klein-base-4B),
revision `a3b4f4849157f664bdbc776fd7453c2783562f4d`. Its transformer is different
from the four-step model; it is not the distilled model sampled longer.

The user's evaluation requires generation entirely through nodal MCP, using
original dataset references. ImageGen and images derived from it are excluded
from generation inputs. Saved requests and nodal run receipts accompany images.
The first comparison holds the prompt, four references, seed, and dimensions
fixed, and changes the model with its appropriate sampling settings. One image
per model is a comparison example, not evidence of an average quality gain.

Base support was developed on `codex/flux2-base-test`, based on the earlier FLUX.2
implementation at `3387c5c`, and integrated into main for tester handoff on
September 17. Testers no longer need a separate FLUX.2 checkout. Matching local
weights are still required; passing the integration tests does not establish
generation quality for every model configuration.

Historical validation on September 3: the full `tools/ci-local.sh` reported 23 passed,
2 failed, and 10 skipped steps. Python and diffusion tests, type checks, and
schema checks passed. The remaining failures are frontend formatting and
generated API TypeScript drift in untouched files. The complete log is retained
at the primary checkout's `output/nodal-runtime/ci-flux2-base-final-20260903.log`.
