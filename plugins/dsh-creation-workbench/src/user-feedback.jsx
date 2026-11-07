import React from 'react'
import { userFacingError } from './user-feedback.mjs'
import './user-feedback.css'

export function UserError({ error, className = '', announce = true }) {
  const feedback = userFacingError(error)
  return <div className={`wtt-user-error ${className}`} role={announce ? 'alert' : undefined}>
    <p>{feedback.summary}</p>
    {feedback.hasDetail && <details><summary>详细原因</summary><pre>{feedback.detail}</pre></details>}
  </div>
}
