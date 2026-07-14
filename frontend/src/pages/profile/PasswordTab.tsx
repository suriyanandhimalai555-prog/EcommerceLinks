import { FormField } from '../../components/ui/FormField'

export function PasswordTab() {
  return (
    <div className="avg-card p-5 space-y-4">
      <FormField label="Current Password" type="password" placeholder="••••••••" />
      <FormField label="New Password" type="password" placeholder="Min 8 characters" />
      <FormField label="Confirm New Password" type="password" placeholder="Repeat new password" />
      <button className="avg-btn-primary">Update Password</button>
    </div>
  )
}
