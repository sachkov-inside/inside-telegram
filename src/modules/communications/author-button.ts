import {
  validateContent,
  type TemplateContent,
} from "./communications-contract.js";

export function validateAuthorButtonUrl(
  title: string | undefined,
  url: string,
) {
  validateContent({
    type: "text",
    text: "Кнопка",
    entities: [],
    buttons: [{ text: title, url }],
  });
}

export function appendAuthorButton(
  content: TemplateContent,
  text: string,
  url: string,
  row: number,
): TemplateContent {
  const updated = {
    ...content,
    buttons: [...content.buttons, { text, url, row }],
  };
  validateContent(updated);
  return updated;
}
