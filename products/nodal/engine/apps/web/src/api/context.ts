import { createContext } from "react";

import type { AssetRef } from "./types";
import { assetSrc } from "./types";

/** 라이브 API와 목 데이터가 같은 이미지 위젯을 쓰기 위한 에셋 URL 경계. */
export const AssetUrlContext = createContext<(asset: AssetRef) => string>(assetSrc);
