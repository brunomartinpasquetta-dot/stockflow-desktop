/**
 * Desktop — área principal del MDI donde flotan las ventanas internas.
 */
import { useWindowManager } from '@/contexts/WindowManagerContext'
import { InternalWindow } from '@/components/InternalWindow'
import { WelcomeScreen } from '@/components/WelcomeScreen'

export function Desktop() {
  const wm = useWindowManager()
  const visible = wm.windows.filter((w) => w.state !== 'minimized')
  const showWelcome = visible.length === 0

  return (
    <div className="relative min-h-0 flex-1 overflow-hidden bg-gradient-to-br from-slate-50 to-slate-100 dark:from-slate-900 dark:to-slate-950">
      {showWelcome && <WelcomeScreen />}
      {wm.windows.map((w) => (
        <InternalWindow key={w.id} window={w} />
      ))}
    </div>
  )
}
