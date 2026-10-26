# E-signature provider outage

**You'll notice:** "Send for signature" fails with "a connected service is temporarily unavailable", or signed agreements don't move to Executed.

1. Agreements that weren't sent stay **Ready to send**; nothing is lost. Retry later. Sending is idempotent per agreement: the envelope ID is derived from the agreement, so the provider never gets a second one.
2. Signed agreements that don't update: the signature event is delayed or quarantined. Check Billing → Provider exceptions (signature events) and the provider's audit trail. Redeliver from the provider once it is healthy; duplicates are ignored.
3. If the provider confirms the agreement is fully signed but its events are lost, use the provider's "document completed" redelivery. The `document.completed` event is treated as authoritative and executes the agreement once.
4. Never mark an agreement executed by editing the database; the guard trigger refuses it. If a paper or offline signature has to stand in temporarily, record it as an amendment note and use the workspace **manual override** (audited and visibly marked) to start work.
