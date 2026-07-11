import { useState } from 'react'
import { useForm } from 'react-hook-form'
import { ChevronDown, ChevronRight, TicketCheck, Mail } from 'lucide-react'
import { FormField } from '../components/ui/FormField'

const FAQ = [
  { q: 'How does the pair match bonus work?', a: 'You earn ₹1,000 for every matched pair of activations in your left and right legs. The system automatically matches left and right activations.' },
  { q: 'What is the weekly wallet cap?', a: 'Your wallet can accumulate up to ₹1,00,000 per week (Sun 18:00 – Sat 17:59 IST). Any excess is deferred to the following week.' },
  { q: 'When are payouts processed?', a: 'Payouts are processed every Saturday to KYC and bank-verified members. 5% TDS is deducted as per Sec 194H.' },
  { q: 'What is the difference between Active and Qualified?', a: 'Active counts drive your ₹1,000 pair bonus. Qualified counts drive your rank ladder — a member qualifies only after their own direct recruit becomes active.' },
  { q: 'How do I change my phone number?', a: 'Phone number changes require identity verification. Please raise a support ticket and our team will assist you.' },
  { q: 'How long does KYC verification take?', a: 'KYC verification is typically completed within 2-3 business days after document submission.' },
]

export default function Support() {
  const [openFaq, setOpenFaq] = useState<number | null>(null)
  const { register, handleSubmit, reset } = useForm()

  const onSubmit = (data: any) => {
    window.location.href = `mailto:support@avilavetrigroups.com?subject=Support: ${data.subject}&body=${data.message}`
    reset()
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-bold text-ink">Support Center</h1>
        <p className="text-sm text-ink-muted">Get help with your account and earnings</p>
      </div>

      <div className="grid lg:grid-cols-2 gap-6">
        {/* Ticket form */}
        <div className="avg-card p-5">
          <div className="flex items-center gap-2 mb-4">
            <div className="w-8 h-8 bg-primary-50 rounded-lg flex items-center justify-center">
              <TicketCheck size={16} className="text-primary" />
            </div>
            <h2 className="text-sm font-semibold text-ink">Raise a Support Ticket</h2>
          </div>
          <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
            <FormField label="Subject" placeholder="Briefly describe your issue" {...register('subject')} required />
            <div className="space-y-1.5">
              <label className="text-sm font-medium text-ink">Message <span className="text-danger">*</span></label>
              <textarea
                className="w-full rounded-lg border border-surface-line px-3 py-2.5 text-sm outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary transition-all h-32 resize-none"
                placeholder="Describe your issue in detail..."
                {...register('message')}
              />
            </div>
            <div className="flex items-center gap-2 text-xs text-ink-muted">
              <Mail size={12} />
              This will open your email client to send the ticket.
            </div>
            <button type="submit" className="avg-btn-primary w-full py-2.5">
              <TicketCheck size={15} /> Submit Ticket
            </button>
          </form>
        </div>

        {/* FAQ */}
        <div className="space-y-4">
          <h2 className="text-sm font-semibold text-ink">Frequently Asked Questions</h2>
          <div className="space-y-2">
            {FAQ.map((item, i) => (
              <div key={i} className="avg-card overflow-hidden">
                <button
                  onClick={() => setOpenFaq(openFaq === i ? null : i)}
                  className="w-full flex items-center justify-between p-4 text-left hover:bg-white/5 transition-colors cursor-pointer"
                >
                  <span className="text-sm font-medium text-ink pr-4">{item.q}</span>
                  {openFaq === i ? <ChevronDown size={15} className="text-ink-muted flex-shrink-0" /> : <ChevronRight size={15} className="text-ink-muted flex-shrink-0" />}
                </button>
                {openFaq === i && (
                  <div className="px-4 pb-4 text-sm text-ink-muted border-t border-surface-line pt-3 animate-fade-in">
                    {item.a}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}
