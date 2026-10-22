import {
  Activity,
  Blocks,
  Bot,
  CalendarClock,
  ChevronDown,
  Code2,
  Key,
  KeyRound,
  LayoutGrid,
  LogOut,
  Moon,
  Radio,
  RadioTower,
  Settings,
  Sun,
  Zap,
} from 'lucide-react'
import { NavLink } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { useAuth } from '@/lib/auth/auth-context'
import { useTheme } from '@/lib/theme/theme-provider'
import { cn } from '@/lib/utils/cn'

interface NavItem {
  title: string
  href: string
  icon: React.ComponentType<{ className?: string }>
  badge?: string
}

interface NavGroup {
  label: string
  items: NavItem[]
}

const navGroups: NavGroup[] = [
  {
    label: 'Automations',
    items: [
      { title: 'Overview', href: '/', icon: LayoutGrid },
      { title: 'Integrations', href: '/integrations', icon: Blocks },
      { title: 'Connections', href: '/connections', icon: KeyRound },
      { title: 'Actions', href: '/actions', icon: Zap },
      { title: 'Triggers', href: '/triggers', icon: Radio },
      { title: 'Trigger Bindings', href: '/automations/triggers', icon: RadioTower },
      { title: 'Scheduled Tasks', href: '/automations/schedules', icon: CalendarClock },
    ],
  },
  {
    label: 'AI & Tools',
    items: [
      { title: 'MCP Hub', href: '/mcp', icon: Bot },
    ],
  },
  {
    label: 'Monitoring',
    items: [
      { title: 'Activity', href: '/activity', icon: Activity },
    ],
  },
  {
    label: 'Platform',
    items: [
      { title: 'Developers', href: '/developers', icon: Code2 },
      { title: 'API Keys', href: '/api-keys', icon: Key },
      { title: 'Settings', href: '/settings', icon: Settings },
    ],
  },
]

export function Sidebar({ className }: { className?: string }) {
  const { t } = useTranslation()
  const { user, currentProject, projects, setCurrentProject, signOut } = useAuth()
  const { setTheme, isDark } = useTheme()

  const userInitials = user
    ? `${user.firstName?.[0] || ''}${user.lastName?.[0] || ''}`.toUpperCase() || 'U'
    : 'D'

  return (
    <TooltipProvider delayDuration={300}>
      <aside
        className={cn(
          'flex h-screen w-[260px] flex-col border-r border-border bg-card/60 backdrop-blur-xs select-none shrink-0 transition-all',
          className
        )}
      >
        {/* Workspace / Project Header */}
        <div className="flex h-14 items-center border-b border-border px-3 gap-2.5">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary text-primary-foreground shadow-xs">
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" className="h-4.5 w-4.5" fill="none">
              <path d="M10 9H22V13H10V9ZM10 15H18V19H10V15ZM10 21H22V25H10V21Z" fill="currentColor"/>
            </svg>
          </div>

          <DropdownMenu>
            <DropdownMenuTrigger className="flex flex-1 items-center justify-between rounded-md px-2 py-1.5 text-left hover:bg-muted text-foreground transition-colors outline-none cursor-pointer">
              <div className="flex flex-col truncate">
                <span className="text-xs font-bold leading-tight truncate">
                  {currentProject?.displayName || t('No Project')}
                </span>
                <span className="text-[10px] text-muted-foreground leading-tight">{t('Developer Console')}</span>
              </div>
              <ChevronDown className="h-3.5 w-3.5 text-muted-foreground shrink-0 ml-1" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-56">
              <DropdownMenuLabel className="text-xs">{t('Projects')}</DropdownMenuLabel>
              {projects.map((proj) => (
                <DropdownMenuItem
                  key={proj.id}
                  onClick={() => setCurrentProject(proj)}
                  className="cursor-pointer text-xs"
                >
                  <span className="truncate">{proj.displayName}</span>
                  {proj.id === currentProject?.id && (
                    <span className="ml-auto text-[10px] text-primary font-semibold">{t('Active')}</span>
                  )}
                </DropdownMenuItem>
              ))}
              <DropdownMenuSeparator />
              <DropdownMenuItem className="text-xs text-muted-foreground">
                {t('Manage projects in Settings')}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>

        {/* Navigation Items */}
        <div className="flex-1 overflow-y-auto px-3 py-3 space-y-4">
          {navGroups.map((group) => (
            <div key={group.label} className="space-y-1">
              <h4 className="px-2 text-[11px] font-semibold text-muted-foreground/80 uppercase tracking-wider">
                {t(group.label)}
              </h4>
              <div className="space-y-0.5 pt-0.5">
                {group.items.map((item) => (
                  <NavLink
                    key={item.href}
                    to={item.href}
                    end={item.href === '/'}
                    className={({ isActive }) =>
                      cn(
                        'flex items-center gap-2.5 rounded-md px-2.5 py-1.5 text-xs font-medium transition-colors outline-none cursor-pointer',
                        isActive
                          ? 'bg-primary/10 text-primary font-semibold dark:bg-primary/20'
                          : 'text-muted-foreground hover:bg-muted hover:text-foreground'
                      )
                    }
                  >
                    <item.icon className="h-4 w-4 shrink-0 stroke-[1.75]" />
                    <span className="truncate">{t(item.title)}</span>
                    {item.badge && (
                      <span className="ml-auto rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                        {item.badge}
                      </span>
                    )}
                  </NavLink>
                ))}
              </div>
            </div>
          ))}
        </div>

        {/* Footer Area: Theme Toggle & User Pill */}
        <div className="border-t border-border p-3 space-y-2">
          <div className="flex items-center justify-between px-2 py-1 text-xs text-muted-foreground">
            <span className="text-[11px] font-medium">{t('Theme')}</span>
            <div className="flex items-center gap-1">
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    onClick={() => setTheme(isDark ? 'light' : 'dark')}
                    className="flex h-6 w-6 items-center justify-center rounded-md hover:bg-muted text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
                    aria-label={t('Toggle theme')}
                  >
                    {isDark ? <Sun className="h-3.5 w-3.5" /> : <Moon className="h-3.5 w-3.5" />}
                  </button>
                </TooltipTrigger>
                <TooltipContent side="top">
                  <p>{isDark ? t('Switch to light mode') : t('Switch to dark mode')}</p>
                </TooltipContent>
              </Tooltip>
            </div>
          </div>

          <DropdownMenu>
            <DropdownMenuTrigger className="flex w-full items-center gap-2.5 rounded-md p-1.5 text-left hover:bg-muted transition-colors outline-none cursor-pointer">
              <Avatar className="h-7 w-7 border border-border">
                <AvatarFallback className="text-[11px] font-semibold bg-primary/10 text-primary">
                  {userInitials}
                </AvatarFallback>
              </Avatar>
              <div className="flex flex-col truncate flex-1">
                <span className="text-xs font-medium text-foreground truncate leading-tight">
                  {user?.firstName ? `${user.firstName} ${user.lastName || ''}` : t('Developer')}
                </span>
                <span className="text-[10px] text-muted-foreground truncate leading-tight">
                  {user?.email || 'Not signed in'}
                </span>
              </div>
              <ChevronDown className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" side="top" className="w-52 mb-1">
              <DropdownMenuLabel className="text-xs font-normal">
                <div className="flex flex-col space-y-0.5">
                  <p className="text-xs font-semibold text-foreground">
                    {user?.firstName ? `${user.firstName} ${user.lastName || ''}` : t('Developer')}
                  </p>
                  <p className="text-[11px] text-muted-foreground">{user?.email || 'Not signed in'}</p>
                </div>
              </DropdownMenuLabel>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={signOut} className="text-xs text-destructive cursor-pointer gap-2">
                <LogOut className="h-3.5 w-3.5" />
                <span>{t('Sign out')}</span>
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </aside>
    </TooltipProvider>
  )
}
