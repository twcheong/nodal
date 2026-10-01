// 모델 팩 — 첫 실행 마법사가 받는 가중치 묶음. 엔진은 가중치를 스스로 받지 않는다 (models/ 에
// 사람이 넣는 구조). 경로는 엔진의 모델 스캐너 규칙(scanner.py)과 번들 템플릿의 파일명에 맞춘다:
//   models/diffusion_models · text_encoders · vae  (+ 폴더형 diffusers 컴포넌트)
//
// ⚠ 라이선스: 코드(Apache-2.0)와 가중치 라이선스는 별개다. 상용 배포 전에 license 항목을 확인할 것.
//   Comfy-Org/z_image · black-forest-labs/FLUX.2-klein-4B = apache-2.0 (HF 카드 기준, 2026-09-24 조회)
//   multimodalart/MiniMax-H3-Pruned = "other" (MiniMax 자체 약관) — 확인 전 상용 불가로 취급
//   Real-ESRGAN = BSD-3-Clause

export type PackSource =
  /** HF 저장소의 한 파일. */
  | { kind: 'hf-file'; repo: string; path: string; dest: string }
  /** HF 저장소의 폴더(path '' = 전체) — 하위 파일 전부. dest 는 폴더. exclude 는 뺄 하위 경로 접두사. */
  | { kind: 'hf-dir'; repo: string; path: string; dest: string; exclude?: string[] }
  /** 일반 URL 한 파일. */
  | { kind: 'url'; url: string; dest: string }

export interface ModelPack {
  id: string
  label: string
  description: string
  /** 대략 크기 (UI 안내용). 실제 크기는 받기 전에 HF API 로 잰다. */
  approxGB: number
  license: string
  /** 이 팩이 있어야 쓸 수 있는 번들 템플릿. */
  templates: string[]
  /** 먼저 있어야 하는 팩. */
  requires?: string[]
  /** CUDA 전용 (Windows+NVIDIA 에서만 제안). */
  cudaOnly?: boolean
  /** 받고 나면 엔진에 넘길 환경 변수 (값은 models/ 기준 상대 경로). */
  env?: Record<string, string>
  sources: PackSource[]
}

export const MODEL_PACKS: ModelPack[] = [
  {
    id: 'image-base',
    label: '이미지 기본 팩 (Z-Image)',
    description: '글로 새 이미지 만들기, 이미지 → 이미지 리스타일, 여러 장 참고해 새 이미지. 필수 팩입니다.',
    approxGB: 20.7,
    license: 'apache-2.0',
    templates: ['zimage_txt2img', 'zimage_i2i', 'zimage_multi_reference', 'zimage_character_lora'],
    sources: [
      { kind: 'hf-file', repo: 'Comfy-Org/z_image', path: 'split_files/diffusion_models/z_image_bf16.safetensors', dest: 'diffusion_models/z_image_bf16.safetensors' },
      { kind: 'hf-file', repo: 'Comfy-Org/z_image', path: 'split_files/text_encoders/qwen_3_4b.safetensors', dest: 'text_encoders/qwen_3_4b.safetensors' },
      { kind: 'hf-file', repo: 'Comfy-Org/z_image', path: 'split_files/vae/ae.safetensors', dest: 'vae/ae.safetensors' },
    ],
  },
  {
    id: 'flux2-klein',
    label: '멀티 레퍼런스 팩 (FLUX.2 Klein 4B)',
    description: '참고 이미지 여러 장으로 새 장면 만들기.',
    approxGB: 7.9,
    license: 'apache-2.0',
    templates: ['flux2_klein_multi_reference'],
    requires: ['image-base'],   // 텍스트 인코더(qwen_3_4b)를 같이 쓴다
    sources: [
      { kind: 'hf-dir', repo: 'black-forest-labs/FLUX.2-klein-4B', path: 'transformer', dest: 'diffusion_models/FLUX.2-klein-4B-transformer' },
      { kind: 'hf-dir', repo: 'black-forest-labs/FLUX.2-klein-4B', path: 'vae', dest: 'vae/FLUX.2-klein-4B-vae' },
    ],
  },
  {
    id: 'upscale',
    label: '영상 업스케일 팩 (Real-ESRGAN x4)',
    description: '만든 영상을 4배 선명하게.',
    approxGB: 0.07,
    license: 'BSD-3-Clause',
    templates: ['upscale_video'],
    env: { NODAL_UPSCALE_MODEL: 'upscale/RealESRGAN_x4plus.pth' },
    sources: [
      { kind: 'url', url: 'https://github.com/xinntao/Real-ESRGAN/releases/download/v0.1.0/RealESRGAN_x4plus.pth', dest: 'upscale/RealESRGAN_x4plus.pth' },
    ],
  },
  {
    id: 'video-h3',
    label: '영상 팩 (MiniMax H3)',
    description: '텍스트·첫 프레임 → 음성 포함 영상. NVIDIA GPU 16GB+ 와 넉넉한 RAM(64GB+)이 필요합니다.',
    approxGB: 96.6,
    license: 'other (MiniMax 약관 — 상용 전 확인 필요)',
    templates: ['h3_test_video', 'h3_image_video'],
    cudaOnly: true,
    env: { NODAL_H3_MODEL: 'h3/MiniMax-H3-Pruned' },
    sources: [
      // transformer_ref(40GB)는 h3_compare_reference 전용이라 뺀다 — 그 템플릿은 번들에서도 뺐다.
      { kind: 'hf-dir', repo: 'multimodalart/MiniMax-H3-Pruned', path: '', dest: 'h3/MiniMax-H3-Pruned', exclude: ['transformer_ref/'] },
      // Pruned 저장소에는 트랜스포머·텍스트 인코더만 있다. 나머지 컴포넌트는 modular_model_index.json 이
      // MiniMaxAI/MiniMax-H3 를 가리키는데, 엔진(h3.py)은 local_files_only 로 **같은 폴더 안**에서만 찾는다.
      // 그래서 원본 저장소의 해당 하위 폴더를 Pruned 폴더 안으로 같이 받는다.
      ...(['tokenizer', 'processor', 'vae', 'audio_vae', 'scheduler', 'audio_scheduler'] as const).map((sub): PackSource => (
        { kind: 'hf-dir', repo: 'MiniMaxAI/MiniMax-H3', path: sub, dest: `h3/MiniMax-H3-Pruned/${sub}` }
      )),
    ],
  },
]

export function getPack(id: string): ModelPack | undefined {
  return MODEL_PACKS.find((p) => p.id === id)
}
