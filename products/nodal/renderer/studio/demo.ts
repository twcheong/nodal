// 데모 내용 — 처음 온 사용자가 무엇을 적어야 할지 몰라도 "생성" 만 눌러 보며 다섯 단계를 끝까지 밟을 수
// 있게. 짧은 서사형 뮤직비디오 한 편 (같은 인물이 반복 등장 — 워크플로 1번이 가장 잘 맞는 경우).
// 프롬프트는 영어(모델이 잘 따른다), 사람이 읽는 칸은 한국어.
import { characterReferences, locationReference, newShot, type Reference, type Shot, type StudioProject } from './model'

export const DEMO_NAME = '데모 — 옥상의 밤'
export const DEMO_SYNOPSIS =
  '비 그친 서울의 밤. 스물다섯의 민준이 네온이 비치는 옥상에서 헤어진 연인을 기다린다. ' +
  '오지 않을 걸 알면서도 난간에 기대 도시를 내려다보다가, 마지막에 휴대폰 화면이 켜지고 그가 처음으로 웃는다.'
export const DEMO_STYLE = 'cinematic film still, 35mm, shallow depth of field, moody neon night lighting, wet reflections'

export function demoReferences(): Reference[] {
  return [
    ...characterReferences('민준', 'a korean man in his mid twenties, short black hair, slim build, black leather jacket over a white t-shirt, dark jeans'),
    locationReference('서울 옥상', 'a seoul apartment rooftop at night after rain, neon signs, wet concrete floor, city skyline'),
  ]
}

export function demoShots(): Shot[] {
  return [
    newShot({
      title: '도착', durationSec: 5, description: '민준이 젖은 옥상 문을 열고 들어온다.',
      camera: 'wide shot, slow push in',
      imagePrompt: 'a young korean man in a black leather jacket stepping through a rooftop door onto a wet rooftop at night, neon glow, city lights behind',
      motionPrompt: 'he walks forward slowly and looks around, light rain drips from the door frame',
    }),
    newShot({
      title: '기다림', durationSec: 5, description: '난간에 기대 도시를 내려다본다.',
      camera: 'medium shot from behind, static',
      imagePrompt: 'a young korean man leaning on a rooftop railing at night, seen from behind, looking down at the glowing seoul skyline',
      motionPrompt: 'his jacket moves slightly in the wind, city lights flicker in the distance',
    }),
    newShot({
      title: '얼굴', durationSec: 4, description: '기대와 체념이 섞인 얼굴.',
      camera: 'close-up, slow dolly in',
      imagePrompt: 'close-up of a young korean man with short black hair, neon light on his face, thoughtful expression, wet hair',
      motionPrompt: 'he blinks slowly and exhales, a soft breath visible in the cold air',
    }),
    newShot({
      title: '휴대폰', durationSec: 4, description: '손에 든 휴대폰 화면이 켜진다.',
      camera: 'insert shot, over the shoulder',
      imagePrompt: 'over the shoulder shot of a man holding a smartphone on a rooftop at night, the dark screen reflecting neon',
      motionPrompt: 'the phone screen lights up with an incoming message, his thumb moves toward it',
    }),
    newShot({
      title: '미소', durationSec: 5, description: '메시지를 읽고 처음으로 웃는다.',
      camera: 'medium close-up, slow orbit',
      imagePrompt: 'a young korean man in a black leather jacket smiling softly while looking at his phone on a neon lit rooftop at night',
      motionPrompt: 'he looks up from the phone and smiles, the camera slowly circles around him',
    }),
  ]
}

/** 목록의 "데모로 시작" — 내용이 다 채워진 새 프로젝트 (이미지는 사용자가 생성). */
export function demoProject(): Omit<StudioProject, 'id' | 'createdAt' | 'updatedAt'> {
  return {
    version: 1, name: DEMO_NAME, aspect: '16:9', quality: 'standard',
    synopsis: DEMO_SYNOPSIS, style: DEMO_STYLE, stage: 1,
    references: demoReferences(), shots: demoShots(), exports: [],
  }
}
