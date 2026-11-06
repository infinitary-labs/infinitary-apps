import type { UpdateChannel } from "@shared/update";
import { UPDATE_CHANNEL_NAMES, UPDATE_WORDS } from "@shared/updateWords";
import { chooseUpdateChannel, useUpdateState } from "../app/updateState";
import { GroupedPills } from "../design";
import { SettingRow } from "./settingRows";

/**
 * INF-640: one installed app remembers Stable or Alpha, beside Version.
 * What the last check found, and every install or restart problem, is the
 * Version row's update line (UpdateCheck.tsx); this row shows only its own
 * problem, a failed channel change.
 */
export function UpdateChannelRow() {
  const { status, channelProblem } = useUpdateState();
  if (!status?.channelChoice) return null;
  return (
    <SettingRow
      id="update-channel"
      title={UPDATE_WORDS.channel}
      description="Stable follows published releases. Alpha includes early releases. Changing channels never installs an older version."
      error={channelProblem}
      control={
        <GroupedPills<UpdateChannel>
          name={UPDATE_WORDS.channel}
          htmlName="update-channel"
          value={status.channel}
          disabled={status.phase === "installing" || status.phase === "ready"}
          options={[
            { value: "stable", label: UPDATE_CHANNEL_NAMES.stable },
            { value: "alpha", label: UPDATE_CHANNEL_NAMES.alpha },
          ]}
          onChange={(next) => {
            void chooseUpdateChannel(next);
          }}
        />
      }
    />
  );
}
