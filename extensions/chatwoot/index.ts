import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { emptyPluginConfigSchema } from "openclaw/plugin-sdk";
import { chatwootDock, chatwootPlugin } from "./src/channel.js";
import { handleChatwootWebhookRequest } from "./src/monitor.js";
import { setChatwootRuntime } from "./src/runtime.js";

const plugin = {
  id: "chatwoot",
  name: "Chatwoot",
  description: "OpenClaw Chatwoot channel plugin",
  configSchema: emptyPluginConfigSchema(),
  register(api: OpenClawPluginApi) {
    setChatwootRuntime(api.runtime);
    api.registerChannel({ plugin: chatwootPlugin, dock: chatwootDock });
    api.registerHttpHandler(handleChatwootWebhookRequest);
  },
};

export default plugin;
