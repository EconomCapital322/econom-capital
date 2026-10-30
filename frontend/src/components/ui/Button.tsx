import type { ButtonHTMLAttributes, ReactElement } from 'react'

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'outline'
}

export function Button({
  variant = 'primary',
  className = '',
  type = 'button',
  ...props
}: ButtonProps): ReactElement {
  return (
    <button
      {...props}
      type={type}
      className={`btn app-button ${variant === 'outline' ? 'app-button--outline' : ''} ${className}`}
    />
  )
}
