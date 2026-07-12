export type ProfileId = string & { __profile: true };

export interface ChatProfilePair {
  chatId: string;
  profileId: ProfileId;
  pairedAt: string;
}

export interface ProfileMeta {
  profileId: ProfileId;
  createdAt: string;
  label: string;
  chatIds: string[];
}
