// The slice of the Telegram Bot API the bot uses (https://core.telegram.org/bots/api, 10.5).

export type TgUser = { id: number; is_bot?: boolean; first_name?: string; username?: string; language_code?: string };
export type TgChat = { id: number; type: 'private' | 'group' | 'supergroup' | 'channel' };

export type TgPhotoSize = { file_id: string; file_unique_id: string; width: number; height: number; file_size?: number };
export type TgFile = { file_id: string; file_unique_id: string; file_size?: number; file_path?: string };
export type TgVoice = { file_id: string; file_unique_id: string; duration: number; mime_type?: string; file_size?: number };
export type TgDocument = { file_id: string; file_unique_id: string; file_name?: string; mime_type?: string; file_size?: number };
export type TgVideoNote = { file_id: string; file_unique_id: string; length: number; duration: number; file_size?: number };

export type TgMessage = {
  message_id: number;
  date: number;
  chat: TgChat;
  from?: TgUser;
  text?: string;
  caption?: string;
  media_group_id?: string;
  photo?: TgPhotoSize[];
  document?: TgDocument;
  voice?: TgVoice;
  audio?: TgVoice & { title?: string };
  video_note?: TgVideoNote;
  entities?: { type: string; offset: number; length: number }[];
};

export type TgCallbackQuery = {
  id: string;
  from: TgUser;
  message?: { message_id: number; chat: TgChat; date: number; text?: string; reply_markup?: InlineKeyboard };
  data?: string;
};

export type TgUpdate = {
  update_id: number;
  message?: TgMessage;
  edited_message?: TgMessage;
  callback_query?: TgCallbackQuery;
};

export type InlineButton = { text: string; callback_data?: string; url?: string; web_app?: { url: string } };
export type InlineKeyboard = { inline_keyboard: InlineButton[][] };

export type SendOptions = {
  parse_mode?: 'HTML';
  reply_markup?: InlineKeyboard;
  disable_notification?: boolean;
  link_preview_options?: { is_disabled: boolean };
  reply_parameters?: { message_id: number; allow_sending_without_reply?: boolean };
};
