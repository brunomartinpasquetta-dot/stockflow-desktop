import { useState } from 'react'
import { BRANDING } from '@/assets/branding'
import { useNavigate } from 'react-router-dom'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { useQuery } from '@tanstack/react-query'
import { z } from 'zod'
import { toast } from 'sonner'
import { Loader2 } from 'lucide-react'

import { useAuth } from '@/contexts/AuthContext'
import { destinoDeConfig, useLanContext } from '@/contexts/LanContext'
import { api, ApiError } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Card, CardContent } from '@/components/ui/card'

const loginSchema = z.object({
  username: z.string().min(1, 'Ingrese el usuario').max(50),
  password: z.string().min(1, 'Ingrese la contraseña').max(100),
})
type LoginValues = z.infer<typeof loginSchema>

export function Login() {
  const navigate = useNavigate()
  const { login } = useAuth()
  const [submitting, setSubmitting] = useState(false)
  const versionQuery = useQuery({ queryKey: ['version'], queryFn: api.system.getVersion })
  // PC DE SUCURSAL (app instalada conectada por dirección web): se ingresa con
  // un usuario de la CASA CENTRAL, y eso hay que decirlo; si no, el empleado
  // del otro local no sabe qué usuario poner. Las terminales de red local y
  // las de navegador no ven nada nuevo.
  const { mode, config, online } = useLanContext()
  const esWeb = Boolean((window as { __stockflowWeb?: boolean }).__stockflowWeb)
  const sucursal = mode === 'client' && Boolean(config?.serverUrl) && !esWeb
  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<LoginValues>({ resolver: zodResolver(loginSchema), defaultValues: { username: '', password: '' } })

  const onSubmit = handleSubmit(async ({ username, password }) => {
    setSubmitting(true)
    try {
      await login(username, password)
      navigate('/', { replace: true })
    } catch (err) {
      if (err instanceof ApiError && err.code === 'VALIDATION') toast.error('Usuario o contraseña incorrectos')
      else toast.error(err instanceof Error ? err.message : 'No se pudo iniciar sesión')
    } finally {
      setSubmitting(false)
    }
  })

  return (
    <div className="flex h-full items-center justify-center bg-secondary/40 p-4">
      <Card className="w-full max-w-sm">
        <CardContent className="flex flex-col gap-3 pt-6">
          <img
            src={BRANDING.logoHorizontal}
            alt="StockFlow"
            className="mx-auto mb-6 h-auto w-[320px]"
          />
          <div className="flex flex-col gap-1">
            <Label htmlFor="login-user">Usuario</Label>
            <Input
              id="login-user"
              autoFocus
              autoComplete="username"
              onKeyDown={(e) => {
                if (e.key === 'Enter') void onSubmit()
              }}
              {...register('username')}
            />
            {errors.username && <span className="text-xs text-destructive">{errors.username.message}</span>}
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor="login-pass">Contraseña</Label>
            <Input
              id="login-pass"
              type="password"
              autoComplete="current-password"
              onKeyDown={(e) => {
                if (e.key === 'Enter') void onSubmit()
              }}
              {...register('password')}
            />
            {errors.password && <span className="text-xs text-destructive">{errors.password.message}</span>}
          </div>
          <Button className="mt-1 w-full" onClick={() => void onSubmit()} disabled={submitting}>
            {submitting && <Loader2 className="h-4 w-4 animate-spin" />}
            Ingresar
          </Button>
          {sucursal && (
            <div className="flex flex-col items-center gap-1 text-center text-xs">
              {online ? (
                <p className="text-muted-foreground">
                  Esta PC trabaja con la casa central ({destinoDeConfig(config)}). Ingrese con el usuario y la contraseña
                  que le dio la casa central.
                </p>
              ) : (
                <p className="text-destructive">
                  Sin conexión con la casa central: no se puede ingresar hasta que vuelva. Revise internet en esta PC y
                  avise a la casa central.
                </p>
              )}
              {/* Una PC revocada (o que la central ya no reconoce) no puede
                  ingresar, y sin sesión no llega a Configuración: este es el
                  único camino para cargar un código nuevo. */}
              <button
                type="button"
                className="text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
                onClick={() => navigate('/bienvenida', { state: { paso: 'sucursal', desde: 'login' } })}
              >
                Conectar esta PC con un código nuevo
              </button>
            </div>
          )}
          {import.meta.env.DEV && (
            <p className="text-center text-xs text-muted-foreground">
              Credenciales por defecto: <span className="font-mono">admin</span> / <span className="font-mono">admin</span>
            </p>
          )}
          <p className="text-center text-xs text-muted-foreground">
            Versión {versionQuery.data?.version ?? '—'} — Gestión comercial
          </p>
        </CardContent>
      </Card>
    </div>
  )
}
