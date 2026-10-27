/**
 * Validação de arquivos de texto do prontuário.
 * Confere extensão, tamanho e a ASSINATURA BINÁRIA ("magic bytes") do conteúdo —
 * o tipo MIME enviado pelo navegador não é confiável e não é usado para decidir.
 */
import crypto from 'node:crypto';
import { invalido } from '../middleware/erros.js';

export const FORMATOS = {
  txt: { mime: 'text/plain; charset=utf-8', assinatura: null },
  doc: { mime: 'application/msword', assinatura: [0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1] },
  docx: { mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', assinatura: [0x50, 0x4B, 0x03, 0x04] },
  pdf: { mime: 'application/pdf', assinatura: [0x25, 0x50, 0x44, 0x46] },
};

export const extensaoDe = (nome = '') => (String(nome).toLowerCase().match(/\.([a-z0-9]+)$/) || [])[1] || '';

/** Remove caminhos e caracteres proibidos do nome do arquivo. */
export function sanitizarNome(nome) {
  const base = String(nome || '').split(/[\\/]/).pop().normalize('NFC');
  const limpo = base.replace(/[\u0000-\u001f<>:"|?*]+/g, '-').replace(/\s+/g, ' ').trim().slice(0, 200);
  if (!limpo || limpo.startsWith('.')) throw invalido('Nome de arquivo inválido.');
  return limpo;
}

export const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

/** Decodifica .txt: UTF-8 estrito; se falhar, Windows-1252 (arquivos salvos no Bloco de Notas antigo). */
export function textoDeBuffer(buf) {
  if (buf.includes(0)) throw invalido('O arquivo .txt contém dados binários — não é um arquivo de texto.');
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf).replace(/^\uFEFF/, '');
  } catch {
    return new TextDecoder('windows-1252').decode(buf);
  }
}

/**
 * Valida um arquivo e devolve { nome, ext, mime, buffer } normalizados.
 * Arquivos .txt são regravados em UTF-8 (sem BOM) para padronizar a edição.
 */
export function validarArquivo(nomeOriginal, buffer, maxBytes) {
  const nome = sanitizarNome(nomeOriginal);
  const ext = extensaoDe(nome);
  const fmt = FORMATOS[ext];
  if (!fmt) throw invalido('Formato não permitido. Envie arquivos .txt, .doc, .docx ou .pdf.');
  if (!buffer || !buffer.length) throw invalido('O arquivo está vazio.');
  if (buffer.length > maxBytes) throw invalido(`Arquivo acima do tamanho máximo (${Math.round(maxBytes / 1048576)} MB).`);
  if (fmt.assinatura && !fmt.assinatura.every((b, i) => buffer[i] === b)) {
    throw invalido(`O conteúdo não corresponde a um arquivo .${ext} válido.`);
  }
  const final = ext === 'txt' ? Buffer.from(textoDeBuffer(buffer), 'utf8') : buffer;
  if (!final.length) throw invalido('O arquivo está vazio.');
  return { nome, ext, mime: fmt.mime, buffer: final };
}

/** Content-Disposition seguro para nomes com acentos (RFC 6266 / 5987). */
export function contentDisposition(nome, tipo = 'attachment') {
  const ascii = nome.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `${tipo}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(nome)}`;
}
