import { migrateToV2 } from "./v2"
import { migrateToV3 } from "./v3"
import { migrateToV4 } from "./v4"

export const migrateSettings = (settings) => {
  settings = migrateToV2(settings)
  settings = migrateToV3(settings)
  settings = migrateToV4(settings)
  return settings
}