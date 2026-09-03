import type { HarmonyApi } from '@shared/types'

declare global {
  interface Window {
    harmony: HarmonyApi
  }
}

export {}
