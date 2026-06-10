export const APP_CONFIG = Object.freeze({
  appName: "VILLAMOR INADIMPLÊNCIA",
  dataProvider: new URLSearchParams(window.location.search).get("mode") === "local"
    ? "local"
    : "supabase",
  environment: "cloud",
  cloud: {
    supabaseUrl: "https://vvslbuolpbcqwwmdgzuz.supabase.co",
    supabasePublishableKey: "sb_publishable_k3oivLau6XDLW742MohDTA_Vqmwmash",
  },
});
