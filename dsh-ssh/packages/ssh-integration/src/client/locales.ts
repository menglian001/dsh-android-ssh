/**
 * Locale bundles for the ssh-remote card.
 *
 * The card owns one dictionary namespace (`settings.ssh`) registered by the
 * client plugin's `apply`; the keys cover the card chrome (shared vocabulary
 * like save/discard lives in the settings section's own dictionary, so this
 * bundle carries only what the SSH card itself renders).
 */

/** Locale keys the ssh-remote card renders. */
export type SshCardLocaleKey =
  | 'sshTitle' | 'sshDescription'
  | 'sshHost' | 'sshHostHint'
  | 'sshPort' | 'sshPortHint'
  | 'sshUsername' | 'sshUsernameHint'
  | 'sshAuthMode' | 'sshAuthModeHint'
  | 'sshAuthPassword' | 'sshAuthPrivateKey'
  | 'sshPrivateKeyPath' | 'sshPrivateKeyPathHint'
  | 'sshCwd' | 'sshCwdHint'
  | 'sshReconnectAttempts' | 'sshReconnectAttemptsHint'
  | 'sshReconnectDelayMs' | 'sshReconnectDelayMsHint'
  | 'sshPassword' | 'sshPasswordHint' | 'sshPasswordSet' | 'sshPasswordUnset'
  | 'sshPrivateKey' | 'sshPrivateKeyHint' | 'sshPrivateKeySet' | 'sshPrivateKeyUnset'
  | 'sshPassphrase' | 'sshPassphraseHint' | 'sshPassphraseSet' | 'sshPassphraseUnset'
  | 'sshStatusTitle' | 'sshStatusState' | 'sshStatusGeneration' | 'sshStatusAttempt'
  | 'sshStatusFingerprint' | 'sshStatusOffered'
  | 'sshStateDisconnected' | 'sshStateConnecting' | 'sshStateConnected'
  | 'sshStateRetrying' | 'sshStateTrustRequired' | 'sshStateKeyChanged'
  | 'sshStateExhausted' | 'sshStateDisposed'
  | 'sshTestConnection' | 'sshTrustKey' | 'sshClearTrust' | 'sshReconnect'
  | 'overridden' | 'reset' | 'invalidValue' | 'save' | 'saving' | 'discard'
  | 'unsaved' | 'saveFailed' | 'readOnly' | 'expand' | 'collapse'

/** Chinese dictionary. */
export const zh: Record<SshCardLocaleKey, string> = {
  sshTitle: 'SSH 远程执行',
  sshDescription: '通过 SSH 在服务器上执行命令与代码',
  sshHost: '服务器地址',
  sshHostHint: 'SSH 服务器的主机名或 IP',
  sshPort: '端口',
  sshPortHint: '1–65535，默认 22',
  sshUsername: '用户名',
  sshUsernameHint: '登录服务器的用户名',
  sshAuthMode: '登录方式',
  sshAuthModeHint: '密码或私钥登录',
  sshAuthPassword: '密码',
  sshAuthPrivateKey: '私钥',
  sshPrivateKeyPath: '私钥路径（服务器）',
  sshPrivateKeyPathHint: '私钥存放在服务器上的路径，留空表示使用下方内联私钥',
  sshCwd: '远程工作目录',
  sshCwdHint: '必须是绝对路径，例如 /srv/project',
  sshReconnectAttempts: '自动重连次数',
  sshReconnectAttemptsHint: '断线后自动重连的次数，0 表示关闭自动重连',
  sshReconnectDelayMs: '重连间隔（毫秒）',
  sshReconnectDelayMsHint: '每次自动重连之间等待的毫秒数',
  sshPassword: 'SSH 密码',
  sshPasswordHint: '密码登录方式使用',
  sshPasswordSet: '已设置',
  sshPasswordUnset: '未设置',
  sshPrivateKey: 'SSH 私钥',
  sshPrivateKeyHint: '私钥登录方式使用，可粘贴完整私钥内容',
  sshPrivateKeySet: '已设置',
  sshPrivateKeyUnset: '未设置',
  sshPassphrase: '私钥口令',
  sshPassphraseHint: '私钥加密时需要填写',
  sshPassphraseSet: '已设置',
  sshPassphraseUnset: '未设置',
  sshStatusTitle: '连接状态',
  sshStatusState: '状态',
  sshStatusGeneration: '连接代数',
  sshStatusAttempt: '重连尝试',
  sshStatusFingerprint: '已信任指纹',
  sshStatusOffered: '待确认指纹',
  sshStateDisconnected: '未连接',
  sshStateConnecting: '连接中',
  sshStateConnected: '已连接',
  sshStateRetrying: '自动重连中',
  sshStateTrustRequired: '需要确认服务器指纹',
  sshStateKeyChanged: '服务器指纹已变化',
  sshStateExhausted: '自动重连已耗尽',
  sshStateDisposed: '已关闭',
  sshTestConnection: '测试连接',
  sshTrustKey: '信任此指纹',
  sshClearTrust: '清除信任',
  sshReconnect: '手动重连',
  overridden: '已覆盖',
  reset: '重置',
  invalidValue: '该值不可用',
  save: '保存',
  saving: '保存中…',
  discard: '放弃更改',
  unsaved: '有未保存更改',
  saveFailed: '保存失败，草稿已保留',
  readOnly: '设置文档为只读',
  expand: '展开',
  collapse: '折叠',
}

/** English dictionary. */
export const en: Record<SshCardLocaleKey, string> = {
  sshTitle: 'SSH remote execution',
  sshDescription: 'Run commands and code on your server over SSH',
  sshHost: 'Server address',
  sshHostHint: 'Hostname or IP of the SSH server',
  sshPort: 'Port',
  sshPortHint: '1–65535, default 22',
  sshUsername: 'Username',
  sshUsernameHint: 'User name to log in as',
  sshAuthMode: 'Authentication',
  sshAuthModeHint: 'Password or private key',
  sshAuthPassword: 'Password',
  sshAuthPrivateKey: 'Private key',
  sshPrivateKeyPath: 'Private key path (server)',
  sshPrivateKeyPathHint: 'Path of the key on the server; empty uses the inline key below',
  sshCwd: 'Remote working directory',
  sshCwdHint: 'Must be an absolute path, e.g. /srv/project',
  sshReconnectAttempts: 'Auto-reconnect attempts',
  sshReconnectAttemptsHint: 'Attempts after a lost transport; 0 disables auto-reconnect',
  sshReconnectDelayMs: 'Reconnect delay (ms)',
  sshReconnectDelayMsHint: 'Milliseconds to wait between automatic attempts',
  sshPassword: 'SSH password',
  sshPasswordHint: 'Used in password mode',
  sshPasswordSet: 'Set',
  sshPasswordUnset: 'Not set',
  sshPrivateKey: 'SSH private key',
  sshPrivateKeyHint: 'Used in private-key mode; paste the full key body',
  sshPrivateKeySet: 'Set',
  sshPrivateKeyUnset: 'Not set',
  sshPassphrase: 'Key passphrase',
  sshPassphraseHint: 'Needed when the private key is encrypted',
  sshPassphraseSet: 'Set',
  sshPassphraseUnset: 'Not set',
  sshStatusTitle: 'Connection',
  sshStatusState: 'State',
  sshStatusGeneration: 'Generation',
  sshStatusAttempt: 'Attempt',
  sshStatusFingerprint: 'Trusted fingerprint',
  sshStatusOffered: 'Offered fingerprint',
  sshStateDisconnected: 'Disconnected',
  sshStateConnecting: 'Connecting',
  sshStateConnected: 'Connected',
  sshStateRetrying: 'Reconnecting',
  sshStateTrustRequired: 'Server key must be confirmed',
  sshStateKeyChanged: 'Server key changed',
  sshStateExhausted: 'Reconnect attempts exhausted',
  sshStateDisposed: 'Disposed',
  sshTestConnection: 'Test connection',
  sshTrustKey: 'Trust this key',
  sshClearTrust: 'Clear trust',
  sshReconnect: 'Reconnect now',
  overridden: 'Overridden',
  reset: 'Reset',
  invalidValue: 'Not a valid value',
  save: 'Save',
  saving: 'Saving…',
  discard: 'Discard changes',
  unsaved: 'Unsaved changes',
  saveFailed: 'Save failed; drafts kept',
  readOnly: 'The settings document is read-only',
  expand: 'Expand',
  collapse: 'Collapse',
}
