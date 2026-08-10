export type ProfileId = string & { __profile: true };

export interface ProfileMeta {
  profileId: ProfileId;
  createdAt: string;
  label: string;
  chatIds: string[];
}
