import { AlertCircle, Eye, EyeOff, Loader2, Sparkles } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import type {
  AIProviderAuthConfig,
  AIProviderConfig,
  AIProviderWithoutSensitiveData,
  CreateAIProviderRequest,
  UpdateAIProviderRequest,
} from '@inboxfm-connect/shared'
import { AIProviderName } from '@/lib/api/ai-providers'
import { ApiClientError } from '@/lib/api/client'

const PROVIDER_OPTIONS: { name: AIProviderName; label: string; defaultDisplayName: string }[] = [
  { name: AIProviderName.OPENAI, label: 'OpenAI', defaultDisplayName: 'OpenAI' },
  { name: AIProviderName.ANTHROPIC, label: 'Anthropic Claude', defaultDisplayName: 'Anthropic' },
  { name: AIProviderName.GOOGLE, label: 'Google Gemini', defaultDisplayName: 'Google Gemini' },
  { name: AIProviderName.OPENROUTER, label: 'OpenRouter', defaultDisplayName: 'OpenRouter' },
  { name: AIProviderName.MISTRAL, label: 'Mistral AI', defaultDisplayName: 'Mistral' },
  { name: AIProviderName.AZURE, label: 'Azure OpenAI', defaultDisplayName: 'Azure OpenAI' },
  { name: AIProviderName.BEDROCK, label: 'AWS Bedrock', defaultDisplayName: 'AWS Bedrock' },
  { name: AIProviderName.CUSTOM, label: 'Custom (OpenAI-Compatible)', defaultDisplayName: 'Custom Provider' },
  { name: AIProviderName.CLOUDFLARE_GATEWAY, label: 'Cloudflare AI Gateway', defaultDisplayName: 'Cloudflare Gateway' },
]

export interface AIProviderDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  editingProvider?: AIProviderWithoutSensitiveData | null
  saving: boolean
  onSaveCreate: (req: CreateAIProviderRequest) => Promise<void>
  onSaveUpdate: (id: string, req: UpdateAIProviderRequest) => Promise<void>
}

export function AIProviderDialog({
  open,
  onOpenChange,
  editingProvider,
  saving,
  onSaveCreate,
  onSaveUpdate,
}: AIProviderDialogProps) {
  const isEditing = !!editingProvider

  const [provider, setProvider] = useState<AIProviderName>(AIProviderName.OPENAI)
  const [displayName, setDisplayName] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [showKey, setShowKey] = useState(false)

  // Azure specific
  const [azureResource, setAzureResource] = useState('')
  const [azureApiVersion, setAzureApiVersion] = useState('')

  // Bedrock specific
  const [bedrockAccessKey, setBedrockAccessKey] = useState('')
  const [bedrockSecretKey, setBedrockSecretKey] = useState('')
  const [bedrockRegion, setBedrockRegion] = useState('us-east-1')
  const [showBedrockSecret, setShowBedrockSecret] = useState(false)

  // Custom / OpenAI-Compatible specific
  const [customBaseUrl, setCustomBaseUrl] = useState('')
  const [customKeyHeader, setCustomKeyHeader] = useState('Authorization')

  // Cloudflare Gateway specific
  const [cfAccountId, setCfAccountId] = useState('')
  const [cfGatewayId, setCfGatewayId] = useState('')

  // Validation / Error state
  const [validationError, setValidationError] = useState<string | null>(null)

  useEffect(() => {
    if (open) {
      setValidationError(null)
      setShowKey(false)
      setShowBedrockSecret(false)

      if (editingProvider) {
        setProvider(editingProvider.provider)
        setDisplayName(editingProvider.name)
        setApiKey('')

        // Extract any existing config
        const conf = (editingProvider.config || {}) as Record<string, string | undefined>
        if (editingProvider.provider === AIProviderName.AZURE) {
          setAzureResource(conf.resourceName || '')
          setAzureApiVersion(conf.apiVersion || '')
        } else if (editingProvider.provider === AIProviderName.BEDROCK) {
          setBedrockRegion(conf.region || 'us-east-1')
          setBedrockAccessKey('')
          setBedrockSecretKey('')
        } else if (editingProvider.provider === AIProviderName.CUSTOM) {
          setCustomBaseUrl(conf.baseUrl || '')
          setCustomKeyHeader(conf.apiKeyHeader || 'Authorization')
        } else if (editingProvider.provider === AIProviderName.CLOUDFLARE_GATEWAY) {
          setCfAccountId(conf.accountId || '')
          setCfGatewayId(conf.gatewayId || '')
        }
      } else {
        const defaultChoice = PROVIDER_OPTIONS[0]
        setProvider(defaultChoice.name)
        setDisplayName(defaultChoice.defaultDisplayName)
        setApiKey('')
        setAzureResource('')
        setAzureApiVersion('')
        setBedrockAccessKey('')
        setBedrockSecretKey('')
        setBedrockRegion('us-east-1')
        setCustomBaseUrl('')
        setCustomKeyHeader('Authorization')
        setCfAccountId('')
        setCfGatewayId('')
      }
    }
  }, [open, editingProvider])

  const handleProviderSelect = (newProvider: AIProviderName) => {
    setProvider(newProvider)
    const opt = PROVIDER_OPTIONS.find((o) => o.name === newProvider)
    if (opt && (!displayName || PROVIDER_OPTIONS.some((o) => o.defaultDisplayName === displayName))) {
      setDisplayName(opt.defaultDisplayName)
    }
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setValidationError(null)

    if (!displayName.trim()) {
      setValidationError('Display name is required')
      return
    }

    try {
      if (isEditing) {
        let authObj: AIProviderAuthConfig | undefined = undefined
        let configObj: AIProviderConfig | undefined = undefined

        if (provider === AIProviderName.BEDROCK) {
          const hasAccess = Boolean(bedrockAccessKey.trim())
          const hasSecret = Boolean(bedrockSecretKey.trim())
          if ((hasAccess && !hasSecret) || (!hasAccess && hasSecret)) {
            setValidationError('Both Access Key ID and Secret Access Key must be provided (or leave both empty to keep existing credentials)')
            return
          }
          if (hasAccess && hasSecret) {
            authObj = { accessKeyId: bedrockAccessKey.trim(), secretAccessKey: bedrockSecretKey.trim() }
          }
          configObj = { region: bedrockRegion.trim() || 'us-east-1' }
        } else if (provider === AIProviderName.AZURE) {
          if (apiKey.trim()) {
            authObj = { apiKey: apiKey.trim() }
          }
          configObj = {
            resourceName: azureResource.trim(),
            apiVersion: azureApiVersion.trim() || undefined,
          }
        } else if (provider === AIProviderName.CUSTOM) {
          if (apiKey.trim()) {
            authObj = { apiKey: apiKey.trim() }
          }
          const prevConfig = editingProvider?.config
          const prevModels = prevConfig && 'models' in prevConfig && Array.isArray(prevConfig.models)
            ? prevConfig.models
            : []
          const prevHeaders = prevConfig && 'defaultHeaders' in prevConfig && typeof prevConfig.defaultHeaders === 'object' && prevConfig.defaultHeaders !== null
            ? (prevConfig.defaultHeaders as Record<string, string>)
            : undefined

          configObj = {
            baseUrl: customBaseUrl.trim(),
            apiKeyHeader: customKeyHeader.trim() || 'Authorization',
            models: prevModels,
            ...(prevHeaders ? { defaultHeaders: prevHeaders } : {}),
          }
        } else if (provider === AIProviderName.CLOUDFLARE_GATEWAY) {
          if (apiKey.trim()) {
            authObj = { apiKey: apiKey.trim() }
          }
          const prevConfig = editingProvider?.config
          const prevModels = prevConfig && 'models' in prevConfig && Array.isArray(prevConfig.models)
            ? prevConfig.models
            : []
          const prevVertexProject = prevConfig && 'vertexProject' in prevConfig && typeof prevConfig.vertexProject === 'string'
            ? prevConfig.vertexProject
            : undefined
          const prevVertexRegion = prevConfig && 'vertexRegion' in prevConfig && typeof prevConfig.vertexRegion === 'string'
            ? prevConfig.vertexRegion
            : undefined

          configObj = {
            accountId: cfAccountId.trim(),
            gatewayId: cfGatewayId.trim(),
            models: prevModels,
            ...(prevVertexProject ? { vertexProject: prevVertexProject } : {}),
            ...(prevVertexRegion ? { vertexRegion: prevVertexRegion } : {}),
          }
        } else {
          // Standard providers
          if (apiKey.trim()) {
            authObj = { apiKey: apiKey.trim() }
          }
          configObj = {}
        }

        const updateReq: UpdateAIProviderRequest = {
          displayName: displayName.trim(),
          ...(authObj ? { auth: authObj } : {}),
          ...(configObj ? { config: configObj } : {}),
        }

        await onSaveUpdate(editingProvider.id, updateReq)
        onOpenChange(false)
      } else {
        // Create Request
        if (provider === AIProviderName.BEDROCK) {
          if (!bedrockAccessKey.trim() || !bedrockSecretKey.trim()) {
            setValidationError('AWS Access Key ID and Secret Access Key are required')
            return
          }
          const req: CreateAIProviderRequest = {
            displayName: displayName.trim(),
            provider: AIProviderName.BEDROCK,
            auth: { accessKeyId: bedrockAccessKey.trim(), secretAccessKey: bedrockSecretKey.trim() },
            config: { region: bedrockRegion.trim() || 'us-east-1' },
          }
          await onSaveCreate(req)
        } else if (provider === AIProviderName.AZURE) {
          if (!apiKey.trim() || !azureResource.trim()) {
            setValidationError('API Key and Resource Name are required for Azure OpenAI')
            return
          }
          const req: CreateAIProviderRequest = {
            displayName: displayName.trim(),
            provider: AIProviderName.AZURE,
            auth: { apiKey: apiKey.trim() },
            config: {
              resourceName: azureResource.trim(),
              apiVersion: azureApiVersion.trim() || undefined,
            },
          }
          await onSaveCreate(req)
        } else if (provider === AIProviderName.CUSTOM) {
          if (!apiKey.trim() || !customBaseUrl.trim()) {
            setValidationError('API Key and Base URL are required for Custom Provider')
            return
          }
          const req: CreateAIProviderRequest = {
            displayName: displayName.trim(),
            provider: AIProviderName.CUSTOM,
            auth: { apiKey: apiKey.trim() },
            config: {
              baseUrl: customBaseUrl.trim(),
              apiKeyHeader: customKeyHeader.trim() || 'Authorization',
              models: [],
            },
          }
          await onSaveCreate(req)
        } else if (provider === AIProviderName.CLOUDFLARE_GATEWAY) {
          if (!apiKey.trim() || !cfAccountId.trim() || !cfGatewayId.trim()) {
            setValidationError('API Key, Account ID, and Gateway ID are required for Cloudflare Gateway')
            return
          }
          const req: CreateAIProviderRequest = {
            displayName: displayName.trim(),
            provider: AIProviderName.CLOUDFLARE_GATEWAY,
            auth: { apiKey: apiKey.trim() },
            config: {
              accountId: cfAccountId.trim(),
              gatewayId: cfGatewayId.trim(),
              models: [],
            },
          }
          await onSaveCreate(req)
        } else {
          // Standard providers: OpenAI, Anthropic, Google, OpenRouter, Mistral
          if (!apiKey.trim()) {
            setValidationError('API Key is required')
            return
          }
          const req = {
            displayName: displayName.trim(),
            provider,
            auth: { apiKey: apiKey.trim() },
            config: {},
          } as CreateAIProviderRequest
          await onSaveCreate(req)
        }
        onOpenChange(false)
      }
    } catch (err: unknown) {
      setValidationError(extractProviderErrorMessage(err))
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg p-6">
        <form onSubmit={handleSubmit} className="space-y-4">
          <DialogHeader className="pb-1">
            <div className="flex items-center gap-2">
              <Sparkles className="h-5 w-5 text-primary" />
              <DialogTitle className="text-base font-bold">
                {isEditing ? `Edit AI Provider — ${editingProvider.name}` : 'Configure AI Provider'}
              </DialogTitle>
            </div>
            <DialogDescription className="text-xs">
              {isEditing
                ? 'Update display name or credentials for this provider.'
                : 'Connect an AI provider to enable LLM-driven actions, tools, and chat.'}
            </DialogDescription>
          </DialogHeader>

          {validationError && (
            <div
              role="alert"
              className="flex items-start gap-2.5 p-3 rounded-md bg-destructive/10 border border-destructive/20 text-xs text-destructive"
            >
              <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" />
              <div className="space-y-0.5">
                <span className="font-semibold">Validation Failed</span>
                <p className="opacity-90">{validationError}</p>
              </div>
            </div>
          )}

          <div className="space-y-3.5 pt-1">
            {!isEditing ? (
              <div className="space-y-1.5">
                <label className="text-xs font-semibold text-foreground" htmlFor="provider-select">
                  Provider Type
                </label>
                <select
                  id="provider-select"
                  value={provider}
                  onChange={(e) => handleProviderSelect(e.target.value as AIProviderName)}
                  className="flex h-9 w-full cursor-pointer rounded-md border border-input bg-card px-3 text-sm shadow-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
                >
                  {PROVIDER_OPTIONS.map((opt) => (
                    <option key={opt.name} value={opt.name}>
                      {opt.label}
                    </option>
                  ))}
                </select>
              </div>
            ) : null}

            <div className="space-y-1.5">
              <label className="text-xs font-semibold text-foreground" htmlFor="display-name-input">
                Display Name
              </label>
              <Input
                id="display-name-input"
                placeholder="e.g. OpenAI Production"
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                className="text-xs h-9"
                required
              />
            </div>

            {/* Provider-specific Credential Fields */}
            {provider === AIProviderName.BEDROCK ? (
              <>
                <div className="space-y-1.5">
                  <label className="text-xs font-semibold text-foreground" htmlFor="bedrock-region">
                    AWS Region
                  </label>
                  <Input
                    id="bedrock-region"
                    placeholder="us-east-1"
                    value={bedrockRegion}
                    onChange={(e) => setBedrockRegion(e.target.value)}
                    className="text-xs h-9"
                    required
                  />
                </div>
                <div className="space-y-1.5">
                  <label className="text-xs font-semibold text-foreground" htmlFor="bedrock-access-key">
                    AWS Access Key ID
                  </label>
                  <Input
                    id="bedrock-access-key"
                    placeholder={isEditing ? '(Unchanged)' : 'AKIA...'}
                    value={bedrockAccessKey}
                    onChange={(e) => setBedrockAccessKey(e.target.value)}
                    className="text-xs h-9 font-mono"
                    required={!isEditing}
                  />
                </div>
                <div className="space-y-1.5">
                  <label className="text-xs font-semibold text-foreground" htmlFor="bedrock-secret-key">
                    AWS Secret Access Key
                  </label>
                  <div className="relative">
                    <Input
                      id="bedrock-secret-key"
                      type={showBedrockSecret ? 'text' : 'password'}
                      placeholder={isEditing ? '••••••••••••••••' : 'Secret Access Key'}
                      value={bedrockSecretKey}
                      onChange={(e) => setBedrockSecretKey(e.target.value)}
                      className="text-xs h-9 font-mono pr-9"
                      required={!isEditing}
                    />
                    <button
                      type="button"
                      onClick={() => setShowBedrockSecret(!showBedrockSecret)}
                      className="absolute right-2.5 top-2.5 text-muted-foreground hover:text-foreground"
                      aria-label={showBedrockSecret ? 'Hide secret key' : 'Show secret key'}
                    >
                      {showBedrockSecret ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                    </button>
                  </div>
                </div>
              </>
            ) : provider === AIProviderName.AZURE ? (
              <>
                <div className="space-y-1.5">
                  <label className="text-xs font-semibold text-foreground" htmlFor="azure-resource">
                    Azure Resource Name
                  </label>
                  <Input
                    id="azure-resource"
                    placeholder="my-azure-openai"
                    value={azureResource}
                    onChange={(e) => setAzureResource(e.target.value)}
                    className="text-xs h-9"
                    required
                  />
                </div>
                <div className="space-y-1.5">
                  <label className="text-xs font-semibold text-foreground" htmlFor="azure-version">
                    API Version
                  </label>
                  <Input
                    id="azure-version"
                    placeholder="2024-10-21"
                    value={azureApiVersion}
                    onChange={(e) => setAzureApiVersion(e.target.value)}
                    className="text-xs h-9 font-mono"
                  />
                </div>
                <div className="space-y-1.5">
                  <label className="text-xs font-semibold text-foreground" htmlFor="api-key-input">
                    API Key
                  </label>
                  <div className="relative">
                    <Input
                      id="api-key-input"
                      type={showKey ? 'text' : 'password'}
                      placeholder={isEditing ? '••••••••••••••••' : 'Enter Azure API key'}
                      value={apiKey}
                      onChange={(e) => setApiKey(e.target.value)}
                      className="text-xs h-9 font-mono pr-9"
                      required={!isEditing}
                    />
                    <button
                      type="button"
                      onClick={() => setShowKey(!showKey)}
                      className="absolute right-2.5 top-2.5 text-muted-foreground hover:text-foreground"
                      aria-label={showKey ? 'Hide API key' : 'Show API key'}
                    >
                      {showKey ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                    </button>
                  </div>
                </div>
              </>
            ) : provider === AIProviderName.CUSTOM ? (
              <>
                <div className="space-y-1.5">
                  <label className="text-xs font-semibold text-foreground" htmlFor="custom-url">
                    Base URL
                  </label>
                  <Input
                    id="custom-url"
                    placeholder="https://api.together.xyz/v1"
                    value={customBaseUrl}
                    onChange={(e) => setCustomBaseUrl(e.target.value)}
                    className="text-xs h-9 font-mono"
                    required
                  />
                </div>
                <div className="space-y-1.5">
                  <label className="text-xs font-semibold text-foreground" htmlFor="custom-header">
                    API Key Header
                  </label>
                  <Input
                    id="custom-header"
                    placeholder="Authorization"
                    value={customKeyHeader}
                    onChange={(e) => setCustomKeyHeader(e.target.value)}
                    className="text-xs h-9 font-mono"
                  />
                </div>
                <div className="space-y-1.5">
                  <label className="text-xs font-semibold text-foreground" htmlFor="api-key-input">
                    API Key / Token
                  </label>
                  <div className="relative">
                    <Input
                      id="api-key-input"
                      type={showKey ? 'text' : 'password'}
                      placeholder={isEditing ? '••••••••••••••••' : 'Enter API key or token'}
                      value={apiKey}
                      onChange={(e) => setApiKey(e.target.value)}
                      className="text-xs h-9 font-mono pr-9"
                      required={!isEditing}
                    />
                    <button
                      type="button"
                      onClick={() => setShowKey(!showKey)}
                      className="absolute right-2.5 top-2.5 text-muted-foreground hover:text-foreground"
                      aria-label={showKey ? 'Hide API key' : 'Show API key'}
                    >
                      {showKey ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                    </button>
                  </div>
                </div>
              </>
            ) : provider === AIProviderName.CLOUDFLARE_GATEWAY ? (
              <>
                <div className="space-y-1.5">
                  <label className="text-xs font-semibold text-foreground" htmlFor="cf-account">
                    Cloudflare Account ID
                  </label>
                  <Input
                    id="cf-account"
                    placeholder="Account ID"
                    value={cfAccountId}
                    onChange={(e) => setCfAccountId(e.target.value)}
                    className="text-xs h-9 font-mono"
                    required
                  />
                </div>
                <div className="space-y-1.5">
                  <label className="text-xs font-semibold text-foreground" htmlFor="cf-gateway">
                    AI Gateway ID
                  </label>
                  <Input
                    id="cf-gateway"
                    placeholder="Gateway ID"
                    value={cfGatewayId}
                    onChange={(e) => setCfGatewayId(e.target.value)}
                    className="text-xs h-9 font-mono"
                    required
                  />
                </div>
                <div className="space-y-1.5">
                  <label className="text-xs font-semibold text-foreground" htmlFor="api-key-input">
                    API Key
                  </label>
                  <div className="relative">
                    <Input
                      id="api-key-input"
                      type={showKey ? 'text' : 'password'}
                      placeholder={isEditing ? '••••••••••••••••' : 'Enter Cloudflare API token'}
                      value={apiKey}
                      onChange={(e) => setApiKey(e.target.value)}
                      className="text-xs h-9 font-mono pr-9"
                      required={!isEditing}
                    />
                    <button
                      type="button"
                      onClick={() => setShowKey(!showKey)}
                      className="absolute right-2.5 top-2.5 text-muted-foreground hover:text-foreground"
                      aria-label={showKey ? 'Hide API key' : 'Show API key'}
                    >
                      {showKey ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                    </button>
                  </div>
                </div>
              </>
            ) : (
              /* Standard providers: OpenAI, Anthropic, Google, OpenRouter, Mistral */
              <div className="space-y-1.5">
                <label className="text-xs font-semibold text-foreground" htmlFor="api-key-input">
                  API Key
                </label>
                <div className="relative">
                  <Input
                    id="api-key-input"
                    type={showKey ? 'text' : 'password'}
                    placeholder={
                      isEditing
                        ? '•••••••••••••••• (leave empty to keep current)'
                        : `Enter ${provider} API key (e.g. sk-...)`
                    }
                    value={apiKey}
                    onChange={(e) => setApiKey(e.target.value)}
                    className="text-xs h-9 font-mono pr-9"
                    required={!isEditing}
                  />
                  <button
                    type="button"
                    onClick={() => setShowKey(!showKey)}
                    className="absolute right-2.5 top-2.5 text-muted-foreground hover:text-foreground"
                    aria-label={showKey ? 'Hide API key' : 'Show API key'}
                  >
                    {showKey ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                  </button>
                </div>
                <p className="text-[11px] text-muted-foreground">
                  Credentials are encrypted at rest with AES-256 and verified against the upstream provider before saving.
                </p>
              </div>
            )}
          </div>

          <DialogFooter className="mt-5 gap-2 sm:gap-0">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => onOpenChange(false)}
              disabled={saving}
              className="text-xs"
            >
              Cancel
            </Button>
            <Button
              type="submit"
              size="sm"
              disabled={saving}
              className="text-xs gap-1.5 shadow-xs"
            >
              {saving ? (
                <>
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  <span>Validating & Saving...</span>
                </>
              ) : (
                <span>{isEditing ? 'Save Changes' : 'Connect Provider'}</span>
              )}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

const DEFAULT_VALIDATION_ERROR = 'Failed to validate credentials. Please check your API key and try again.'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

// Credential validation happens server-side: the API rejects a bad key with an
// ActivepiecesError whose JSON body is `{ code, params }` — the human-readable
// reason lives in `params.message`, with no top-level `message` field. Read the
// raw response body from ApiClientError.details so the banner explains what
// failed instead of collapsing to "Request failed with status 400".
function extractProviderErrorMessage(err: unknown): string {
  if (err instanceof ApiClientError && isRecord(err.details)) {
    const params = err.details.params
    if (isRecord(params)) {
      if (typeof params.message === 'string' && params.message.length > 0) {
        return params.message
      }
      if (typeof params.error === 'string' && params.error.length > 0) {
        return params.error
      }
    }
    if (typeof err.details.message === 'string' && err.details.message.length > 0) {
      return err.details.message
    }
  }
  if (err instanceof Error && err.message.length > 0) {
    return err.message
  }
  if (isRecord(err) && typeof err.message === 'string' && err.message.length > 0) {
    return err.message
  }
  return DEFAULT_VALIDATION_ERROR
}
