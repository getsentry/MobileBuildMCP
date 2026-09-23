# Contacts UI benchmark

Task:
1. Launch Contacts on the configured simulator.
2. Create exactly one new contact with these details:
   - First name: `MCP`
   - Last name: `Contact Benchmark`
   - Organization: `MobileBuildMCP Benchmark`
   - Phone: `555-010-4242`
   - Email: `mcp.contact.benchmark@example.com`
3. Save the contact.
4. Verify the saved contact by observing the saved contact card only.

Verification rules:
- Do not enter edit mode after saving.
- Do not change, retype, normalize, delete, or clean up any saved contact data during verification.
- Verification means reading the saved card using UI snapshots and, only if needed, a screenshot.
- Phone-number display formatting may differ by locale. Treat the phone as correct if the saved card visibly contains the same digits as `555-010-4242` in any grouping or punctuation.
- Organization casing may differ. Treat it as correct if the saved card visibly contains the same words as `MobileBuildMCP Benchmark`.

Return a concise final summary of what you created and observed.
