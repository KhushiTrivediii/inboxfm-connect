export function buildRestSnippet({ origin }: BuildRestSnippetProps): string {
  return `curl -X POST "${origin}/api/v1/execute" \\
  -H "Authorization: Bearer <API_KEY>" \\
  -H "Content-Type: application/json" \\
  -d '{
    "projectId": "<PROJECT_ID>",
    "integration": "@inboxfm-connect/piece-slack",
    "tool": "send_message",
    "externalUserId": "user_42",
    "input": {
      "channel": "#general",
      "text": "Hello from my app!"
    }
  }'`
}

export type BuildRestSnippetProps = {
  origin: string
}
