/**
 * Hand-written controls for the ssh-remote card, mirroring the official
 * plugin-card fields (`ui-settings-plugins` reference) with plain HTML: this
 * external plugin does not depend on the workspace's UI primitives package.
 * Each control renders one field's label, its staged text, whether saving
 * would leave an override, and — when one stands — the reset that stages a
 * clear back to the composition layer. Nothing here writes: a control reports
 * what the user typed, and the card's save is the single point where a draft
 * becomes a document mutation.
 */

/** What every field control needs regardless of its value type. */
export interface FieldProps {
  /** Stable id associating the label with its control. */
  id: string
  /** Visible label. */
  label: string
  /** One-line explanation rendered under the control. */
  hint: string
  /** Draft text this control renders. */
  text: string
  /** True when saving would leave a user-layer entry for this field. */
  overridden: boolean
  /** True when the draft is not a value this field accepts. */
  invalid: boolean
  /** Copy for the overridden badge. */
  overriddenLabel: string
  /** Copy for the reset control. */
  resetLabel: string
  /** Copy shown in place of the hint while the draft is invalid. */
  invalidLabel: string
  /** Disables every control (read-only document, or an unavailable namespace). */
  disabled: boolean
  /** Stage draft text. */
  onEdit: (text: string) => void
  /** Stage a clear so the field re-inherits the composition layer. */
  onReset: () => void
}

/**
 * A staged value field. `numeric` only hints the keypad: which drafts a field
 * accepts is decided by its spec, so the control never silently rewrites what
 * the user typed.
 * @param props - the field's copy, its staged text, and the edit actions.
 * @returns the labelled control.
 */
export function ValueField(props: FieldProps & {
  /** Hints a numeric keypad without narrowing what the control accepts. */
  numeric?: boolean
  /** Placeholder shown while the draft is empty. */
  placeholder?: string
}) {
  return (
    <div className="dsh-ssh-field">
      <div className="dsh-ssh-field-head">
        <label className="dsh-ssh-label" htmlFor={props.id}>{props.label}</label>
        {props.overridden
          ? (
            <span className="dsh-ssh-badges">
              <span className="dsh-ssh-badge">{props.overriddenLabel}</span>
              <button
                type="button"
                className="dsh-ssh-reset"
                disabled={props.disabled}
                onClick={props.onReset}
              >
                {props.resetLabel}
              </button>
            </span>
          )
          : null}
      </div>
      <input
        id={props.id}
        className={props.invalid ? 'dsh-ssh-input dsh-ssh-input-invalid' : 'dsh-ssh-input'}
        type="text"
        {...props.numeric === true ? { inputMode: 'numeric' as const } : {}}
        {...props.invalid ? { 'aria-invalid': true } : {}}
        value={props.text}
        placeholder={props.placeholder ?? ''}
        disabled={props.disabled}
        onChange={(event) => { props.onEdit(event.target.value) }}
      />
      <p className={props.invalid ? 'dsh-ssh-hint dsh-ssh-invalid' : 'dsh-ssh-hint'}>
        {props.invalid ? props.invalidLabel : props.hint}
      </p>
    </div>
  )
}

/**
 * A write-only credential control. The value never rides a response, so the
 * control reports only whether one is configured and starts blank; a blank
 * draft writes nothing, which keeps the stored key rather than clearing it.
 * @param props - the field's copy, its staged text, and the configured state.
 * @returns the labelled control.
 */
export function SecretField(props: Pick<FieldProps, 'id' | 'label' | 'hint' | 'text' | 'disabled' | 'onEdit'> & {
  /** Whether the Host reports a configured credential for this reference. */
  configured: boolean
  /** Copy describing the configured state. */
  stateLabel: string
}) {
  return (
    <div className="dsh-ssh-field">
      <div className="dsh-ssh-field-head">
        <label className="dsh-ssh-label" htmlFor={props.id}>{props.label}</label>
        <span className="dsh-ssh-badges">
          <span className={props.configured ? 'dsh-ssh-badge' : 'dsh-ssh-badge dsh-ssh-badge-quiet'}>
            {props.stateLabel}
          </span>
        </span>
      </div>
      <input
        id={props.id}
        className="dsh-ssh-input"
        type="password"
        autoComplete="off"
        value={props.text}
        disabled={props.disabled}
        onChange={(event) => { props.onEdit(event.target.value) }}
      />
      <p className="dsh-ssh-hint">{props.hint}</p>
    </div>
  )
}

/**
 * A select field over a fixed set of spellings. Which drafts are accepted is
 * decided by the field spec; the control only offers the accepted set.
 * @param props - the field's copy, its staged text, the options and the edit action.
 * @returns the labelled control.
 */
export function SelectField(props: Pick<FieldProps, 'id' | 'label' | 'hint' | 'text' | 'disabled' | 'onEdit' | 'overriddenLabel' | 'resetLabel' | 'overridden' | 'onReset'> & {
  /** Options as value/label pairs. */
  options: ReadonlyArray<{ readonly value: string; readonly label: string }>
}) {
  return (
    <div className="dsh-ssh-field">
      <div className="dsh-ssh-field-head">
        <label className="dsh-ssh-label" htmlFor={props.id}>{props.label}</label>
        {props.overridden
          ? (
            <span className="dsh-ssh-badges">
              <span className="dsh-ssh-badge">{props.overriddenLabel}</span>
              <button
                type="button"
                className="dsh-ssh-reset"
                disabled={props.disabled}
                onClick={props.onReset}
              >
                {props.resetLabel}
              </button>
            </span>
          )
          : null}
      </div>
      <select
        id={props.id}
        className="dsh-ssh-input"
        value={props.text}
        disabled={props.disabled}
        onChange={(event) => { props.onEdit(event.target.value) }}
      >
        {props.options.map(option => (
          <option key={option.value} value={option.value}>{option.label}</option>
        ))}
      </select>
      <p className="dsh-ssh-hint">{props.hint}</p>
    </div>
  )
}
