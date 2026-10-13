import { AlertTriangle, Bot, Building2, CreditCard, ExternalLink, Loader2, Moon, Palette, Plus, Shield, Sparkles, Sun, User } from 'lucide-react'
import { useState } from 'react'
import { AIModelBrowserDialog } from '@/components/ai-providers/ai-model-browser-dialog'
import { AIProviderDialog } from '@/components/ai-providers/ai-provider-dialog'
import { AIProvidersTable } from '@/components/ai-providers/ai-providers-table'
import { PageHeader } from '@/components/layout/page-header'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { EmptyState } from '@/components/ui/empty-state'
import { ErrorState } from '@/components/ui/error-state'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { useAuth } from '@/lib/auth/auth-context'
import {
  useAIProvidersQuery,
  useBillingInfoQuery,
  useCreateAIProviderMutation,
  useCreateBillingCheckoutMutation,
  useCreateBillingPortalMutation,
  useDeleteAIProviderMutation,
  useUpdateAIProviderMutation,
} from '@/lib/query/hooks'
import { useTheme } from '@/lib/theme/theme-provider'
import type {
  AIProviderWithoutSensitiveData,
  CreateAIProviderRequest,
  UpdateAIProviderRequest,
} from '@inboxfm-connect/shared'
import { toast } from 'sonner'

// Mirrors the api-keys page gate: backend write endpoints for AI providers
// accept only this platform role.
const PLATFORM_ADMIN_ROLE = 'ADMIN'

export default function SettingsPage() {
  const { user, currentProject } = useAuth()
  const { theme, setTheme } = useTheme()
  // AI provider create/update/delete endpoints are `securityAccess.platformAdminOnly`
  // on the backend, so the mutation affordances must not render for other users.
  const isPlatformAdmin = user?.platformRole === PLATFORM_ADMIN_ROLE
  const billingQuery = useBillingInfoQuery()
  const portalMutation = useCreateBillingPortalMutation()
  const checkoutMutation = useCreateBillingCheckoutMutation()

  const aiProvidersQuery = useAIProvidersQuery()
  const createAIProviderMutation = useCreateAIProviderMutation()
  const updateAIProviderMutation = useUpdateAIProviderMutation()
  const deleteAIProviderMutation = useDeleteAIProviderMutation()

  const [providerDialogOpen, setProviderDialogOpen] = useState(false)
  const [editingProvider, setEditingProvider] = useState<AIProviderWithoutSensitiveData | null>(null)
  const [browsingProvider, setBrowsingProvider] = useState<AIProviderWithoutSensitiveData | null>(null)
  const [deletingProvider, setDeletingProvider] = useState<AIProviderWithoutSensitiveData | null>(null)
  const [togglingChatId, setTogglingChatId] = useState<string | null>(null)

  const aiProviders = aiProvidersQuery.data ?? []

  const handleOpenAddProvider = () => {
    setEditingProvider(null)
    setProviderDialogOpen(true)
  }

  const handleOpenEditProvider = (p: AIProviderWithoutSensitiveData) => {
    setEditingProvider(p)
    setProviderDialogOpen(true)
  }

  const handleSaveCreateProvider = async (req: CreateAIProviderRequest) => {
    await createAIProviderMutation.mutateAsync(req)
    toast.success('AI provider connected successfully')
  }

  const handleSaveUpdateProvider = async (id: string, req: UpdateAIProviderRequest) => {
    await updateAIProviderMutation.mutateAsync({ id, request: req })
    toast.success('AI provider updated successfully')
  }

  const handleDeleteProviderConfirm = async () => {
    if (!deletingProvider) return
    try {
      await deleteAIProviderMutation.mutateAsync(deletingProvider.id)
      toast.success('AI provider removed')
      setDeletingProvider(null)
    } catch (err: unknown) {
      toast.error('Failed to remove provider', {
        description: err instanceof Error ? err.message : 'Please try again',
      })
    }
  }

  const handleToggleChat = async (p: AIProviderWithoutSensitiveData, enabled: boolean) => {
    try {
      setTogglingChatId(p.id)
      await updateAIProviderMutation.mutateAsync({
        id: p.id,
        request: {
          displayName: p.name,
          enabledForChat: enabled,
        },
      })
      toast.success(
        enabled
          ? `${p.name} set as default chat provider`
          : `${p.name} disabled for chat`
      )
    } catch (err: unknown) {
      toast.error('Failed to update chat provider setting', {
        description: err instanceof Error ? err.message : 'Please try again',
      })
    } finally {
      setTogglingChatId(null)
    }
  }

  const billingInfo = billingQuery.data

  async function handleManageBilling() {
    try {
      const { url } = await portalMutation.mutateAsync()
      if (url) {
        window.location.assign(url)
      }
    } catch {
      toast.error('Could not generate Stripe billing portal session')
    }
  }

  async function handleUpgradePlan() {
    try {
      const res = await checkoutMutation.mutateAsync({ newActiveFlowsLimit: 25 })
      const checkoutUrl = res.stripeCheckoutUrl || res.url
      if (checkoutUrl) {
        window.location.assign(checkoutUrl)
      }
    } catch {
      toast.error('Could not initiate Stripe checkout session')
    }
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Settings"
        description="Configure project preferences, developer identity, and console appearance."
      />

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Billing & Subscription */}
        <Card className="border-border shadow-xs col-span-1 lg:col-span-2">
          <CardHeader className="pb-3">
            <div className="flex items-center justify-between">
              <CardTitle className="text-sm font-bold flex items-center gap-2">
                <CreditCard className="h-4 w-4 text-primary" />
                <span>Subscription & Billing</span>
              </CardTitle>
              {billingInfo?.plan?.stripeSubscriptionStatus === 'active' && (
                <Badge variant="outline" className="text-emerald-600 dark:text-emerald-400 border-emerald-500/20 bg-emerald-500/10">
                  Active Subscription
                </Badge>
              )}
              {billingInfo?.plan?.stripeSubscriptionStatus === 'trialing' && (
                <Badge variant="outline" className="text-blue-600 dark:text-blue-400 border-blue-500/20 bg-blue-500/10">
                  Trialing
                </Badge>
              )}
              {billingInfo?.plan?.stripeSubscriptionStatus === 'past_due' && (
                <Badge variant="destructive">
                  Payment Past Due
                </Badge>
              )}
              {billingInfo?.plan?.stripeSubscriptionStatus === 'unpaid' && (
                <Badge variant="destructive">
                  Unpaid
                </Badge>
              )}
              {(billingInfo?.plan?.stripeSubscriptionStatus === 'incomplete' || billingInfo?.plan?.stripeSubscriptionStatus === 'incomplete_expired') && (
                <Badge variant="secondary" className="border-amber-500/30 text-amber-600 dark:text-amber-400 bg-amber-500/10">
                  Incomplete
                </Badge>
              )}
              {billingInfo && (!billingInfo.plan?.stripeSubscriptionStatus || billingInfo.plan?.stripeSubscriptionStatus === 'canceled') && (
                <Badge variant="secondary">
                  Community Plan
                </Badge>
              )}
            </div>
            <CardDescription className="text-xs">
              Manage platform subscription tiers, quotas, and Stripe billing details.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {(billingInfo?.plan?.stripeSubscriptionStatus === 'past_due' || billingInfo?.plan?.stripeSubscriptionStatus === 'unpaid') && (
              <div className="rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-xs text-destructive flex items-start gap-2.5">
                <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />
                <div className="space-y-1">
                  <p className="font-semibold">Your recent subscription payment failed.</p>
                  <p className="text-[11px] opacity-90">Please update your payment method in Stripe to maintain full plan limits and prevent service interruption.</p>
                </div>
              </div>
            )}

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <div className="rounded-lg border border-border p-3 space-y-1">
                <span className="text-[11px] text-muted-foreground uppercase font-semibold">Active Plan</span>
                <p className="text-sm font-bold capitalize text-foreground">{billingInfo?.plan?.plan || 'Unavailable'}</p>
              </div>
              <div className="rounded-lg border border-border p-3 space-y-1">
                <span className="text-[11px] text-muted-foreground uppercase font-semibold">Active Flows Limit</span>
                <p className="text-sm font-bold text-foreground">
                  {billingInfo?.plan?.activeFlowsLimit != null ? billingInfo.plan.activeFlowsLimit : 'Unlimited'}
                </p>
              </div>
              <div className="rounded-lg border border-border p-3 space-y-1">
                <span className="text-[11px] text-muted-foreground uppercase font-semibold">AI Credits</span>
                <p className="text-sm font-bold text-foreground">
                  {billingInfo?.plan?.includedAiCredits ?? 0}
                </p>
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-3 pt-1">
              {billingQuery.isLoading ? (
                <div className="flex items-center gap-2 text-xs text-muted-foreground py-1">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  <span>Loading billing status...</span>
                </div>
              ) : billingQuery.isError ? (
                <div role="alert" className="text-xs text-destructive">Billing status could not be loaded. Reload to try again.</div>
              ) : !billingInfo?.stripeBillingEnabled ? (
                <p className="text-xs text-muted-foreground">Stripe billing is unavailable on this instance.</p>
              ) : billingInfo.plan?.stripeSubscriptionId ? (
                <Button
                  size="sm"
                  variant="outline"
                  className="gap-1.5 text-xs"
                  disabled={portalMutation.isPending}
                  onClick={() => handleManageBilling()}
                >
                  {portalMutation.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ExternalLink className="h-3.5 w-3.5" />}
                  <span>Manage in Stripe</span>
                </Button>
              ) : billingInfo.plan?.plan === 'enterprise' ? (
                <p className="text-xs text-muted-foreground">Enterprise billing is managed by your platform administrator.</p>
              ) : (
                <Button
                  size="sm"
                  className="gap-1.5 text-xs shadow-xs"
                  disabled={checkoutMutation.isPending}
                  onClick={() => handleUpgradePlan()}
                >
                  {checkoutMutation.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />}
                  <span>Upgrade to Paid Tier</span>
                </Button>
              )}
            </div>
          </CardContent>
        </Card>

        {/* AI Providers Management */}
        <Card className="border-border shadow-xs col-span-1 lg:col-span-2">
          <CardHeader className="pb-3">
            <div className="flex items-center justify-between">
              <div>
                <CardTitle className="text-sm font-bold flex items-center gap-2">
                  <Bot className="h-4 w-4 text-primary" />
                  <span>AI Providers</span>
                </CardTitle>
                <CardDescription className="text-xs mt-1">
                  Configure large language model credentials for agent automations, tools, and chat.
                </CardDescription>
              </div>
              {isPlatformAdmin && (
                <Button
                  size="sm"
                  className="gap-1.5 text-xs shadow-xs"
                  onClick={handleOpenAddProvider}
                >
                  <Plus className="h-3.5 w-3.5" />
                  <span>Add Provider</span>
                </Button>
              )}
            </div>
          </CardHeader>
          <CardContent>
            {aiProvidersQuery.isLoading ? (
              <div className="space-y-2 py-2">
                <Skeleton className="h-10 w-full rounded-md" />
                <Skeleton className="h-10 w-full rounded-md" />
              </div>
            ) : aiProvidersQuery.isError ? (
              <ErrorState
                title="Could not load AI providers"
                description="Unable to fetch configured AI providers from the server."
                onRetry={() => void aiProvidersQuery.refetch()}
              />
            ) : aiProviders.length === 0 ? (
              <EmptyState
                icon={Bot}
                title="No AI providers configured"
                description="Connect an API key from OpenAI, Anthropic, Google Gemini, or AWS Bedrock to empower AI agent capabilities."
                actionLabel={isPlatformAdmin ? 'Add AI Provider' : undefined}
                onAction={isPlatformAdmin ? handleOpenAddProvider : undefined}
              />
            ) : (
              <AIProvidersTable
                providers={aiProviders}
                canManage={isPlatformAdmin}
                onEdit={handleOpenEditProvider}
                onDelete={(p) => setDeletingProvider(p)}
                onBrowseModels={(p) => setBrowsingProvider(p)}
                onToggleChat={handleToggleChat}
                togglingId={togglingChatId}
              />
            )}
          </CardContent>
        </Card>

        {/* Project Info */}
        <Card className="border-border shadow-xs">
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-bold flex items-center gap-2">
              <Building2 className="h-4 w-4 text-primary" />
              <span>Project Information</span>
            </CardTitle>
            <CardDescription className="text-xs">
              Current active project on InboxFM Connect platform.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-1">
              <label className="text-xs font-semibold text-foreground">Project Display Name</label>
              <Input
                value={currentProject?.displayName || ''}
                placeholder="No project selected"
                readOnly
              />
            </div>
            <div className="space-y-1">
              <label className="text-xs font-semibold text-foreground">Project ID</label>
              <Input
                value={currentProject?.id || '—'}
                readOnly
                className="font-mono text-xs"
              />
            </div>
          </CardContent>
        </Card>

        {/* User Identity */}
        <Card className="border-border shadow-xs">
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-bold flex items-center gap-2">
              <User className="h-4 w-4 text-primary" />
              <span>Developer Identity</span>
            </CardTitle>
            <CardDescription className="text-xs">
              Authenticated user details.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-1">
              <label className="text-xs font-semibold text-foreground">Email Address</label>
              <Input
                value={user?.email || ''}
                placeholder="Not signed in"
                readOnly
              />
            </div>
            <div className="space-y-1">
              <label className="text-xs font-semibold text-foreground">Platform Role</label>
              <Input
                value={user?.platformRole || '—'}
                readOnly
              />
            </div>
          </CardContent>
        </Card>

        {/* Appearance Settings */}
        <Card className="border-border shadow-xs">
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-bold flex items-center gap-2">
              <Palette className="h-4 w-4 text-primary" />
              <span>Console Appearance</span>
            </CardTitle>
            <CardDescription className="text-xs">
              Customize the theme mode for this developer workstation.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex items-center justify-between">
              <div>
                <span className="text-xs font-semibold text-foreground">Color Theme</span>
                <p className="text-[11px] text-muted-foreground">Select light, dark, or system mode.</p>
              </div>
              <div className="flex items-center gap-1.5 bg-muted/60 p-1 rounded-lg border border-border">
                <Button
                  size="xs"
                  variant={theme === 'light' ? 'default' : 'ghost'}
                  onClick={() => setTheme('light')}
                  className="gap-1 text-xs"
                >
                  <Sun className="h-3.5 w-3.5" />
                  <span>Light</span>
                </Button>
                <Button
                  size="xs"
                  variant={theme === 'dark' ? 'default' : 'ghost'}
                  onClick={() => setTheme('dark')}
                  className="gap-1 text-xs"
                >
                  <Moon className="h-3.5 w-3.5" />
                  <span>Dark</span>
                </Button>
                <Button
                  size="xs"
                  variant={theme === 'system' ? 'default' : 'ghost'}
                  onClick={() => setTheme('system')}
                  className="text-xs"
                >
                  <span>System</span>
                </Button>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Security & Access */}
        <Card className="border-border shadow-xs">
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-bold flex items-center gap-2">
              <Shield className="h-4 w-4 text-primary" />
              <span>Security & Isolation</span>
            </CardTitle>
            <CardDescription className="text-xs">
              Tenant boundary and execution sandboxing controls.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="text-xs text-muted-foreground leading-relaxed">
              Every query and execution is isolated by <code className="font-mono text-primary font-bold">x-project-id</code> and validated through Fastify security middleware. Executions run in an isolated-vm sandbox; outbound network access is restricted to the SafeHttp allowlist.
            </p>
          </CardContent>
        </Card>
      </div>

      {/* AI Provider Modals */}
      <AIProviderDialog
        open={providerDialogOpen}
        onOpenChange={setProviderDialogOpen}
        editingProvider={editingProvider}
        saving={createAIProviderMutation.isPending || updateAIProviderMutation.isPending}
        onSaveCreate={handleSaveCreateProvider}
        onSaveUpdate={handleSaveUpdateProvider}
      />

      <AIModelBrowserDialog
        open={!!browsingProvider}
        onOpenChange={(open) => {
          if (!open) setBrowsingProvider(null)
        }}
        providerName={browsingProvider?.name ?? ''}
        providerType={browsingProvider?.provider ?? null}
      />

      <ConfirmDialog
        open={!!deletingProvider}
        onOpenChange={(open) => {
          if (!open) setDeletingProvider(null)
        }}
        title="Remove AI Provider"
        description={`Are you sure you want to remove ${deletingProvider?.name}? Integrations and flows using this provider will stop working.`}
        confirmLabel="Remove"
        variant="destructive"
        loading={deleteAIProviderMutation.isPending}
        onConfirm={handleDeleteProviderConfirm}
      />
    </div>
  )
}
