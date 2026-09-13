/**
 * The ssh-remote card: the user's single place to configure the SSH server,
 * its credentials and the reconnect policy, and to act on the connection.
 *
 * It renders the official plugin-card pattern (the workspace's
 * `WebSearchCard` is the reference) with plain HTML: a header naming the
 * plugin, staged fields, write-only credential controls, a status line fed by
 * the `sshRemote` Remote namespace, and the connection actions. Nothing here
 * is the security boundary — the Host's gate is; the card is an affordance.
 */

import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { PropsLocale, PropsRuntime, InjectFace } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from './slot-contract.ts'
import { SelectField, SecretField, ValueField } from './card-fields.tsx'
import type { SshCardFace, SshCardState } from './ssh-card-controller.ts'
import type { SshCardLocaleKey } from './locales.ts'

/** Props the renderer binds for the ssh-remote card. */
export type SshCardProps =
  PropsRuntime<'settings.plugin.item'>
  & PropsLocale<'settings.ssh'>
  & InjectFace<SshCardFace>

/** Copy keys for the projected connection states. */
const STATE_KEYS = {
  disconnected: 'sshStateDisconnected',
  connecting: 'sshStateConnecting',
  connected: 'sshStateConnected',
  retrying: 'sshStateRetrying',
  'trust-required': 'sshStateTrustRequired',
  'key-changed': 'sshStateKeyChanged',
  exhausted: 'sshStateExhausted',
  disposed: 'sshStateDisposed',
} as const

/**
 * Render the ssh-remote card.
 * @param props - locale copy, the card snapshot, and its form and connection actions.
 * @returns the card, or nothing while the namespace is unavailable.
 */
export function SshCard(props: SshCardProps) {
  const { t } = props
  const state = props.useSshCard(snapshot => snapshot)
  const [open, setOpen] = useState(false)
  const saveStarted = useRef(false)

  // Collapse only after Host-confirmed settlement; a rejected write keeps its
  // diagnostics and retained drafts visible for correction.
  useEffect(() => {
    if (state.saving) {
      saveStarted.current = true
      return
    }
    if (!saveStarted.current) return
    saveStarted.current = false
    if (!state.dirty && !state.failed) setOpen(false)
  }, [state.dirty, state.failed, state.saving])

  if (!state.available) return null
  const disabled = !state.writable
  const blocked = !state.dirty || state.invalid || state.saving
  const keyMode = state.authMode.text === 'private-key'

  return (
    <li className={open ? 'dsh-ssh-card dsh-ssh-card-open' : 'dsh-ssh-card'}>
      <button
        type="button"
        className="dsh-ssh-header"
        aria-expanded={open}
        aria-label={`${t(open ? 'collapse' : 'expand')}: ${t('sshTitle')}`}
        onClick={() => { setOpen(!open) }}
      >
        <span className="dsh-ssh-head-text">
          <span className="dsh-ssh-name">{t('sshTitle')}</span>
          <span className="dsh-ssh-description">{t('sshDescription')}</span>
        </span>
        {state.dirty ? <span className="dsh-ssh-badge">{t('unsaved')}</span> : null}
        <span className={open ? 'dsh-ssh-chevron dsh-ssh-chevron-open' : 'dsh-ssh-chevron'}>▾</span>
      </button>
      {open
        ? (
          <div className="dsh-ssh-body">
            {!state.writable ? <p className="dsh-ssh-read-only" role="status">{t('readOnly')}</p> : null}
            <ValueField
              id="plugin-config-ssh-host"
              label={t('sshHost')}
              hint={t('sshHostHint')}
              overriddenLabel={t('overridden')}
              resetLabel={t('reset')}
              invalidLabel={t('invalidValue')}
              disabled={disabled}
              {...state.host}
              onEdit={(text) => { props.edit('host', text) }}
              onReset={() => { props.resetField('host') }}
            />
            <ValueField
              id="plugin-config-ssh-port"
              label={t('sshPort')}
              hint={t('sshPortHint')}
              overriddenLabel={t('overridden')}
              resetLabel={t('reset')}
              invalidLabel={t('invalidValue')}
              numeric
              disabled={disabled}
              {...state.port}
              onEdit={(text) => { props.edit('port', text) }}
              onReset={() => { props.resetField('port') }}
            />
            <ValueField
              id="plugin-config-ssh-username"
              label={t('sshUsername')}
              hint={t('sshUsernameHint')}
              overriddenLabel={t('overridden')}
              resetLabel={t('reset')}
              invalidLabel={t('invalidValue')}
              disabled={disabled}
              {...state.username}
              onEdit={(text) => { props.edit('username', text) }}
              onReset={() => { props.resetField('username') }}
            />
            <SelectField
              id="plugin-config-ssh-auth-mode"
              label={t('sshAuthMode')}
              hint={t('sshAuthModeHint')}
              overriddenLabel={t('overridden')}
              resetLabel={t('reset')}
              disabled={disabled}
              options={[
                { value: 'password', label: t('sshAuthPassword') },
                { value: 'private-key', label: t('sshAuthPrivateKey') },
              ]}
              text={state.authMode.text}
              overridden={state.authMode.overridden}
              onEdit={(text) => { props.edit('authMode', text) }}
              onReset={() => { props.resetField('authMode') }}
            />
            {keyMode
              ? (
                <ValueField
                  id="plugin-config-ssh-private-key-path"
                  label={t('sshPrivateKeyPath')}
                  hint={t('sshPrivateKeyPathHint')}
                  overriddenLabel={t('overridden')}
                  resetLabel={t('reset')}
                  invalidLabel={t('invalidValue')}
                  disabled={disabled}
                  {...state.privateKeyPath}
                  onEdit={(text) => { props.edit('privateKeyPath', text) }}
                  onReset={() => { props.resetField('privateKeyPath') }}
                />
              )
              : null}
            <ValueField
              id="plugin-config-ssh-cwd"
              label={t('sshCwd')}
              hint={t('sshCwdHint')}
              overriddenLabel={t('overridden')}
              resetLabel={t('reset')}
              invalidLabel={t('invalidValue')}
              disabled={disabled}
              {...state.cwd}
              onEdit={(text) => { props.edit('cwd', text) }}
              onReset={() => { props.resetField('cwd') }}
            />
            <ValueField
              id="plugin-config-ssh-reconnect-attempts"
              label={t('sshReconnectAttempts')}
              hint={t('sshReconnectAttemptsHint')}
              overriddenLabel={t('overridden')}
              resetLabel={t('reset')}
              invalidLabel={t('invalidValue')}
              numeric
              disabled={disabled}
              {...state.reconnectAttempts}
              onEdit={(text) => { props.edit('reconnectAttempts', text) }}
              onReset={() => { props.resetField('reconnectAttempts') }}
            />
            <ValueField
              id="plugin-config-ssh-reconnect-delay"
              label={t('sshReconnectDelayMs')}
              hint={t('sshReconnectDelayMsHint')}
              overriddenLabel={t('overridden')}
              resetLabel={t('reset')}
              invalidLabel={t('invalidValue')}
              numeric
              disabled={disabled}
              {...state.reconnectDelayMs}
              onEdit={(text) => { props.edit('reconnectDelayMs', text) }}
              onReset={() => { props.resetField('reconnectDelayMs') }}
            />
            <SecretField
              id="plugin-config-ssh-password"
              label={t('sshPassword')}
              hint={t('sshPasswordHint')}
              // The credentials domain accepts a literal even when the
              // settings document is read-only; its own writability governs.
              disabled={disabled}
              text={state.password.text}
              configured={state.passwordConfigured}
              stateLabel={state.passwordConfigured ? t('sshPasswordSet') : t('sshPasswordUnset')}
              onEdit={(text) => { props.edit('password', text) }}
            />
            {keyMode
              ? (
                <>
                  <SecretField
                    id="plugin-config-ssh-private-key"
                    label={t('sshPrivateKey')}
                    hint={t('sshPrivateKeyHint')}
                    disabled={disabled}
                    text={state.privateKey.text}
                    configured={state.privateKeyConfigured}
                    stateLabel={state.privateKeyConfigured ? t('sshPrivateKeySet') : t('sshPrivateKeyUnset')}
                    onEdit={(text) => { props.edit('privateKey', text) }}
                  />
                  <SecretField
                    id="plugin-config-ssh-passphrase"
                    label={t('sshPassphrase')}
                    hint={t('sshPassphraseHint')}
                    disabled={disabled}
                    text={state.passphrase.text}
                    configured={state.passphraseConfigured}
                    stateLabel={state.passphraseConfigured ? t('sshPassphraseSet') : t('sshPassphraseUnset')}
                    onEdit={(text) => { props.edit('passphrase', text) }}
                  />
                </>
              )
              : null}
            <ConnectionStatus t={t} state={state} props={props} />
            <div className="dsh-ssh-footer">
              {state.failed ? <p className="dsh-ssh-failed" role="status">{t('saveFailed')}</p> : null}
              <button
                type="button"
                className="dsh-ssh-discard"
                disabled={!state.dirty || state.saving}
                onClick={props.discard}
              >
                {t('discard')}
              </button>
              <button
                type="button"
                className="dsh-ssh-save"
                disabled={blocked}
                onClick={props.save}
              >
                {t(state.saving ? 'saving' : 'save')}
              </button>
            </div>
          </div>
        )
        : null}
    </li>
  )
}

/** The status line and the four connection actions. */
function ConnectionStatus(props: {
  t: (key: SshCardLocaleKey) => string
  state: SshCardState
  props: SshCardProps
}): ReactNode {
  const { t, state } = props
  const connection = state.connection
  const stateKey = STATE_KEYS[connection.state as keyof typeof STATE_KEYS] ?? 'sshStateDisconnected'
  return (
    <div className="dsh-ssh-status" role="status">
      <p className="dsh-ssh-status-title">{t('sshStatusTitle')}</p>
      <dl className="dsh-ssh-status-grid">
        <dt>{t('sshStatusState')}</dt>
        <dd>{t(stateKey)}</dd>
        <dt>{t('sshStatusGeneration')}</dt>
        <dd>{connection.generation}</dd>
        {connection.attempt > 0 ? <dt>{t('sshStatusAttempt')}</dt> : null}
        {connection.attempt > 0 ? <dd>{connection.attempt}</dd> : null}
        {connection.fingerprint !== undefined
          ? <dt>{t('sshStatusFingerprint')}</dt>
          : null}
        {connection.fingerprint !== undefined ? <dd className="dsh-ssh-mono">{connection.fingerprint}</dd> : null}
        {connection.offeredFingerprint !== undefined
          ? <dt>{t('sshStatusOffered')}</dt>
          : null}
        {connection.offeredFingerprint !== undefined
          ? <dd className="dsh-ssh-mono">{connection.offeredFingerprint}</dd>
          : null}
      </dl>
      <div className="dsh-ssh-actions">
        <button type="button" onClick={() => { void props.props.testConnection() }}>
          {t('sshTestConnection')}
        </button>
        {connection.offeredFingerprint !== undefined
          ? (
            <button
              type="button"
              onClick={() => { void props.props.trustHostKey(connection.offeredFingerprint ?? '') }}
            >
              {t('sshTrustKey')}
            </button>
          )
          : null}
        <button type="button" onClick={() => { void props.props.clearTrustedHost() }}>
          {t('sshClearTrust')}
        </button>
        <button type="button" onClick={() => { void props.props.reconnect() }}>
          {t('sshReconnect')}
        </button>
      </div>
    </div>
  )
}
