import { APP_CONFIG } from "./config.js";
import { Database } from "./database.js?v=20260621-1";
import { SupabaseProvider } from "./supabase-provider.js?v=20260621-1";

export function createDataProvider() {
  if (APP_CONFIG.dataProvider === "local") {
    return new Database();
  }

  if (APP_CONFIG.dataProvider === "supabase") {
    return new SupabaseProvider(APP_CONFIG.cloud);
  }

  throw new Error("Provedor de dados não reconhecido.");
}

export function getDataProviderInfo() {
  return {
    mode: APP_CONFIG.dataProvider,
    environment: APP_CONFIG.environment,
    label: APP_CONFIG.dataProvider === "local" ? "Dados neste dispositivo" : "Dados sincronizados",
  };
}
