import { BookOpen, Check, Code2, Copy, Key, Terminal } from 'lucide-react'
import { useState } from 'react'
import { Link } from 'react-router-dom'
import { toast } from 'sonner'
import { PageHeader } from '@/components/layout/page-header'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { buildRestSnippet } from './snippets'

export default function DevelopersPage() {
  const [copiedKey, setCopiedKey] = useState<string | null>(null)

  const copySnippet = (text: string, label: string) => {
    navigator.clipboard.writeText(text)
    setCopiedKey(label)
    toast.success(`Copied ${label} snippet to clipboard`)
    setTimeout(() => setCopiedKey(null), 2000)
  }

  const installNpm = `npm install @inboxfm-connect/sdk`

  const nodeSnippet = `import { InboxFM } from '@inboxfm-connect/sdk';

const inboxfm = new InboxFM({
  apiKey: process.env.INBOXFM_API_KEY,
  projectId: process.env.INBOXFM_PROJECT_ID,
  baseUrl: '${window.location.origin}/api',
});

// Let one of your end-users connect an account (Slack, Notion, ...)
const session = await inboxfm.createConnectSession({
  externalUserId: 'user_42',
  allowedPieceNames: ['@inboxfm-connect/piece-slack'],
});
// Redirect your user to session.connectUrl to complete the connection

// Then run an action on their behalf
const result = await inboxfm.execute({
  integration: '@inboxfm-connect/piece-slack',
  tool: 'send_message',
  externalUserId: 'user_42',
  input: { channel: '#general', text: 'Hello from my app!' },
});

console.log(result);`

  const restSnippet = buildRestSnippet({ origin: window.location.origin })

  return (
    <div className="space-y-6">
      <PageHeader
        title="Developers & SDK"
        description="API keys, the TypeScript SDK, and REST contracts for embedding InboxFM Connect into your application or AI agents."
      />

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Quickstart Installation */}
        <div className="space-y-4">
          <Card className="border-border shadow-xs">
            <CardHeader className="pb-3">
              <CardTitle className="text-sm font-bold flex items-center gap-2">
                <Terminal className="h-4 w-4 text-primary" />
                <span>SDK Installation</span>
              </CardTitle>
              <CardDescription className="text-xs">
                Install the official Node.js/TypeScript client SDK.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="space-y-1">
                <span className="text-[11px] font-semibold text-muted-foreground">Node.js (npm / bun / pnpm)</span>
                <div className="relative">
                  <pre className="p-3 rounded-md bg-muted/40 font-mono text-xs text-foreground">
                    {installNpm}
                  </pre>
                  <Button
                    size="icon-xs"
                    variant="outline"
                    onClick={() => copySnippet(installNpm, 'npm install')}
                    className="absolute top-2 right-2"
                  >
                    {copiedKey === 'npm install' ? (
                      <Check className="h-3 w-3 text-emerald-500" />
                    ) : (
                      <Copy className="h-3 w-3" />
                    )}
                  </Button>
                </div>
              </div>
            </CardContent>
          </Card>

          <Card className="border-border shadow-xs">
            <CardHeader className="pb-3">
              <CardTitle className="text-sm font-bold flex items-center gap-2">
                <Key className="h-4 w-4 text-amber-500" />
                <span>API Keys</span>
              </CardTitle>
              <CardDescription className="text-xs">
                Manage service keys for headless programmatic execution.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <p className="text-xs text-muted-foreground leading-relaxed">
                Project and platform API keys have a dedicated page with masked values, creation dates, last-used
                activity, and revoke controls.
              </p>
              <Button size="sm" variant="outline" className="gap-1.5 text-xs" asChild>
                <Link to="/api-keys">
                  <Key className="h-3.5 w-3.5" />
                  <span>Manage API Keys</span>
                </Link>
              </Button>
            </CardContent>
          </Card>
        </div>

        {/* Code Examples */}
        <div className="space-y-4">
          <Card className="border-border shadow-xs">
            <CardHeader className="pb-3">
              <CardTitle className="text-sm font-bold flex items-center gap-2">
                <Code2 className="h-4 w-4 text-primary" />
                <span>TypeScript SDK Example</span>
              </CardTitle>
            </CardHeader>
            <CardContent className="relative">
              <pre className="p-3 rounded-md bg-muted/40 font-mono text-[11px] overflow-x-auto max-h-[220px]">
                {nodeSnippet}
              </pre>
              <Button
                size="icon-xs"
                variant="outline"
                onClick={() => copySnippet(nodeSnippet, 'TypeScript')}
                className="absolute top-5 right-5"
              >
                {copiedKey === 'TypeScript' ? (
                  <Check className="h-3 w-3 text-emerald-500" />
                ) : (
                  <Copy className="h-3 w-3" />
                )}
              </Button>
            </CardContent>
          </Card>

          <Card className="border-border shadow-xs">
            <CardHeader className="pb-3">
              <CardTitle className="text-sm font-bold flex items-center gap-2">
                <BookOpen className="h-4 w-4 text-primary" />
                <span>Direct REST API Contract</span>
              </CardTitle>
            </CardHeader>
            <CardContent className="relative">
              <pre className="p-3 rounded-md bg-muted/40 font-mono text-[11px] overflow-x-auto max-h-[180px]">
                {restSnippet}
              </pre>
              <Button
                size="icon-xs"
                variant="outline"
                onClick={() => copySnippet(restSnippet, 'REST')}
                data-testid="copy-rest-snippet"
                className="absolute top-5 right-5"
              >
                {copiedKey === 'REST' ? (
                  <Check className="h-3 w-3 text-emerald-500" />
                ) : (
                  <Copy className="h-3 w-3" />
                )}
              </Button>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  )
}
