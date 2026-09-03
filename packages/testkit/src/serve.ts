import { startFakeAnthropic } from "./fake-anthropic.ts";

const port = Number(process.env.PORT ?? 8790);
const server = await startFakeAnthropic(port);
console.log(`fake anthropic upstream listening on ${server.url}`);
console.log(
  "  BYOK 用法：PUT /v1/provider-keys { provider: anthropic, api_key: sk-ant-fake, base_url: " +
    server.url +
    " }",
);
