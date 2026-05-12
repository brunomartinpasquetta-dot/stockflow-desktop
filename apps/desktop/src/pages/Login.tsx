import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { useQuery } from '@tanstack/react-query'
import { z } from 'zod'
import { toast } from 'sonner'
import { Boxes, Loader2 } from 'lucide-react'

import { useAuth } from '@/contexts/AuthContext'
import { api, ApiError } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'

const loginSchema = z.object({
  username: z.string().min(1, 'Ingresá el usuario').max(50),
  password: z.string().min(1, 'Ingresá la contraseña').max(100),
})
type LoginValues = z.infer<typeof loginSchema>

export function Login() {
  const navigate = useNavigate()
  const { login } = useAuth()
  const [submitting, setSubmitting] = useState(false)
  const versionQuery = useQuery({ queryKey: ['version'], queryFn: api.system.getVersion })
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
        <CardHeader className="items-center gap-2 pt-6 text-center">
          <div className="flex h-12 w-12 items-center justify-center rounded-lg bg-primary text-primary-foreground">
            <Boxes className="h-7 w-7" />
          </div>
          <CardTitle className="text-lg">StockFlow</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
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
          {import.meta.env.DEV && (
            <p className="text-center text-xs text-muted-foreground">
              Credenciales por defecto: <span className="font-mono">admin</span> / <span className="font-mono">admin</span>
            </p>
          )}
          <p className="text-center text-xs text-muted-foreground">
            Versión {versionQuery.data?.version ?? '—'} — Tu solución de gestión comercial
          </p>
        </CardContent>
      </Card>
    </div>
  )
}
