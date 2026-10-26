# AI outage

**You'll notice:** assistants reply "The assistant isn't available right now"; Operations shows AI provider errors; AI usage shows `error` outcomes with a category.

The portal keeps working without AI. Every assistant answer offers a person, and nothing depends on the AI to complete a step (AT-030).

1. Open Dashboard → AI usage and read the error categories:
   - `rate_limited`: the provider's limits were hit; wait or raise them with the provider.
   - `timeout` / `unavailable`: provider outage; check its status page.
   - `invalid_request`: usually a configuration problem (model name, credentials). Check `AI_MODEL` and `ANTHROPIC_API_KEY`.
   - `budget_exceeded`: our own daily limits (`AI_ORG_DAILY_TOKENS`, `AI_ACTOR_DAILY_MESSAGES`). Raise them if the usage is legitimate.
2. To switch the assistant off entirely, set `AI_PROVIDER=disabled` (or `local` for offline extractive answers) and redeploy.
3. If answers look wrong rather than missing, check the "Blocked by policy" and "Said it didn't know" rows. Improve the approved knowledge rather than loosening the policy, then run `npm run ai:eval`.
