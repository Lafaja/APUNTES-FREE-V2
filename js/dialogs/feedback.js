// Diálogo para informar de un error o sugerir una mejora (se envía con core/feedback.js).

import { submitFeedback, diagnosticText, getRecentErrors } from '../core/feedback.js';
import { h } from '../ui/dom.js';
import { openModal } from '../ui/modal.js';
import { toast } from '../ui/toast.js';

const TEXTS = {
  bug: {
    title: 'Informar de un error',
    label: '¿Qué ha pasado?',
    placeholder: 'Qué estabas haciendo, qué esperabas que pasara y qué pasó en realidad.'
  },
  idea: {
    title: 'Sugerir una mejora',
    label: '¿Qué te gustaría mejorar o añadir?',
    placeholder: 'Describe tu idea: qué harías y para qué te serviría.'
  }
};

export function openFeedbackDialog(app, kind = 'bug') {
  const t = TEXTS[kind] || TEXTS.bug;
  const message = h('textarea.text-input.text-area', { rows: 6, placeholder: t.placeholder, autofocus: true, maxlength: 5000 });
  const contact = h('input.text-input', { type: 'text', placeholder: 'Email o nombre (opcional)', autocomplete: 'email', maxlength: 200 });
  const diagInput = h('input', { type: 'checkbox', checked: kind === 'bug' });
  const body = h('div',
    h('label.field', h('span', t.label), message),
    h('label.field', h('span', 'Para poder responderte'), contact),
    h('label.check-row', diagInput, h('span', 'Incluir datos técnicos (versión, navegador, tamaño de pantalla y últimos errores). Nunca se envían tus apuntes.')));

  return openModal({
    title: t.title,
    body,
    buttons: [
      { label: 'Cancelar', value: null, variant: 'btn-ghost' },
      {
        label: 'Enviar',
        icon: 'send',
        variant: 'btn-primary',
        value: true,
        onClick: async btn => {
          const text = message.value.trim();
          if (!text) {
            toast('Escribe primero el mensaje', { type: 'error' });
            message.focus();
            return false;
          }
          btn.disabled = true;
          let diagnostic = '';
          if (diagInput.checked) {
            diagnostic = await diagnosticText(app).catch(() => '');
            const errs = getRecentErrors();
            if (errs.length) diagnostic += `\nÚltimos errores:\n${errs.join('\n')}`;
          }
          const r = await submitFeedback({ kind, message: text, contact: contact.value.trim(), diagnostic });
          if (r === 'failed') {
            btn.disabled = false;
            toast('No se pudo guardar el mensaje. Inténtalo de nuevo.', { type: 'error' });
            return false;
          }
          toast(r === 'sent' ? '¡Gracias! Mensaje enviado.' : '¡Gracias! Mensaje guardado: se enviará solo cuando sea posible.', { type: 'success', duration: 5000 });
          return true;
        }
      }
    ]
  }).promise;
}
