import type {
  AssetInput as Pascal092AssetInput,
  Plugin as Pascal092Plugin,
} from '@mint/pascal-core-0-9-2'
import type {
  AssetInput as Pascal100Beta1AssetInput,
  Plugin as Pascal100Beta1Plugin,
} from '@pascal-app/core'
import { mintPlugin } from '../src/index'
import { mintModelToAsset } from '../src/mapping'

type Assert<T extends true> = T
type IsAssignable<From, To> = [From] extends [To] ? true : false

type MintPluginManifest = typeof mintPlugin
type MintAssetInput = ReturnType<typeof mintModelToAsset>

type Pascal092PluginContract = Assert<IsAssignable<MintPluginManifest, Pascal092Plugin>>
type Pascal100Beta1PluginContract = Assert<IsAssignable<MintPluginManifest, Pascal100Beta1Plugin>>
type Pascal092AssetContract = Assert<IsAssignable<MintAssetInput, Pascal092AssetInput>>
type Pascal100Beta1AssetContract = Assert<
  IsAssignable<MintAssetInput, Pascal100Beta1AssetInput>
>

export type PascalCoreCompatibilityContracts =
  | Pascal092PluginContract
  | Pascal100Beta1PluginContract
  | Pascal092AssetContract
  | Pascal100Beta1AssetContract
