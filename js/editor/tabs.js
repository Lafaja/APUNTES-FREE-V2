// Pestañas de documentos: los documentos abiertos recientemente quedan como pestañas encima de la
// barra del editor para cambiar entre ellos sin volver a la biblioteca. Se recuerdan entre sesiones.
// La barra solo aparece cuando hay al menos dos pestañas.

import { settings } from '../core/settings.js';
import { h, iconEl, $, clear } from '../ui/dom.js';

const MAX_TABS = 12;

export class DocTabs {
  constructor(editor) {
    this.editor = editor;
    this.el = $('#ed-tabs');
    this.screen = $('#screen-editor');
    this.el.addEventListener('click', e => this.onClick(e));
    // Clic con la rueda del ratón = cerrar pestaña (como en los navegadores).
    this.el.addEventListener('auxclick', e => {
      if (e.button !== 1) return;
      const tab = e.target.closest('.ed-tab');
      if (tab) {
        e.preventDefault();
        this.close(tab.dataset.id);
      }
    });
  }

  get app() {
    return this.editor.app;
  }

  /** Ids guardados que siguen siendo documentos válidos (no borrados). */
  ids() {
    const raw = settings.get('openTabs');
    const list = Array.isArray(raw) ? raw.filter(id => typeof id === 'string') : [];
    const open = new Set(this.editor.panes.map(p => p.session.id));
    const lib = this.app.library;
    return list.filter(id => {
      if (open.has(id)) return true;
      const n = lib && lib.nodes.get(id);
      return !!(n && n.kind === 'doc' && lib.isAlive(id));
    });
  }

  save(list) {
    settings.set('openTabs', list);
  }

  /** Se ha abierto un documento: si no tenía pestaña, se añade al final. */
  add(id) {
    const list = this.ids();
    if (!list.includes(id)) {
      list.push(id);
      // Demasiadas: se quita la más antigua que no esté a la vista.
      const shown = new Set(this.editor.panes.map(p => p.session.id));
      while (list.length > MAX_TABS) {
        const i = list.findIndex(x => !shown.has(x));
        if (i === -1) break;
        list.splice(i, 1);
      }
      this.save(list);
    }
    this.render();
  }

  nameOf(id) {
    const pane = this.editor.panes.find(p => p.session.id === id);
    if (pane) return pane.session.node.name;
    const n = this.app.library && this.app.library.nodes.get(id);
    return n ? n.name : 'Documento';
  }

  kindOf(id) {
    const pane = this.editor.panes.find(p => p.session.id === id);
    const n = pane ? pane.session.node : this.app.library && this.app.library.nodes.get(id);
    return n && (n.source === 'pdf' || (n.pdf && n.pdf.blobId)) ? 'fileText' : 'edit';
  }

  render() {
    const list = this.ids();
    const show = list.length >= 2 && this.editor.isOpen();
    this.el.hidden = !show;
    this.screen.classList.toggle('has-tabs', show);
    if (!show) {
      clear(this.el);
      return;
    }
    const active = this.editor.activePane ? this.editor.activePane.session.id : null;
    const shown = new Set(this.editor.panes.map(p => p.session.id));
    const frag = document.createDocumentFragment();
    for (const id of list) {
      const name = this.nameOf(id);
      const tab = h(`div.ed-tab${id === active ? '.active' : shown.has(id) ? '.shown' : ''}`, { role: 'tab', dataset: { id }, 'aria-selected': id === active ? 'true' : 'false' },
        h('button.ed-tab-main', { type: 'button', title: name }, iconEl(this.kindOf(id)), h('span.ed-tab-title', name)),
        h('button.ed-tab-close', { type: 'button', title: 'Cerrar pestaña', 'aria-label': `Cerrar pestaña ${name}` }, iconEl('x')));
      frag.appendChild(tab);
    }
    frag.appendChild(h('button.ed-tab-add', { type: 'button', title: 'Abrir otro documento en una pestaña', 'aria-label': 'Abrir otro documento' }, iconEl('plus')));
    clear(this.el);
    this.el.appendChild(frag);
    const act = this.el.querySelector('.ed-tab.active');
    if (act) act.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }

  async onClick(e) {
    if (e.target.closest('.ed-tab-add')) {
      const id = await this.app.pickDocument({ title: 'Abrir en una pestaña' });
      if (id) await this.show(id);
      return;
    }
    const tab = e.target.closest('.ed-tab');
    if (!tab) return;
    const id = tab.dataset.id;
    if (e.target.closest('.ed-tab-close')) {
      await this.close(id);
      return;
    }
    await this.show(id);
  }

  /** Muestra un documento: en pantalla dual, en el panel activo (o activa el panel que ya lo muestra). */
  async show(id) {
    const ed = this.editor;
    const pane = ed.panes.find(p => p.session.id === id);
    if (pane) {
      ed.setActiveViewer(pane.viewer);
      this.render();
      return;
    }
    if (ed.panes.length > 1 && ed.activePane) {
      await ed.replacePaneDocument(ed.activePane, id);
    } else {
      await this.app.openDocument(id);
    }
  }

  async close(id) {
    const list = this.ids();
    const i = list.indexOf(id);
    if (i === -1) return;
    const ed = this.editor;
    const pane = ed.panes.find(p => p.session.id === id);
    list.splice(i, 1);
    this.save(list);
    if (pane) {
      if (ed.panes.length > 1) {
        await ed.closePane(pane);
      } else {
        // Se cierra el documento que se estaba viendo: pasar a la pestaña de al lado (o a la biblioteca).
        const next = list[i] || list[i - 1];
        if (next) await this.app.openDocument(next);
        else await this.app.closeEditor();
      }
    }
    this.render();
  }
}
