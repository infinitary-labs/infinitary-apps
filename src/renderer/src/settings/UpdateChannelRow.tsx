import type { UpdateChannel } from "@shared/update";
import { UPDATE_PROBLEMS, UPDATE_WORDS } from "@shared/updateWords";
import { chooseUpdateChannel, useUpdateState } from "../app/updateState";
import { GroupedPills } from "../design";
import { SettingRow } from "./settingRows";

/**
 * INF-640: one installed app remembers Stable or Alpha, beside Version.
 * What the last check found is the Version row's line (UpdateCheck.tsx).
 */
export function UpdateChannelRow() {
  const { status, problem } = useUpdateState();
  if (!status?.channelChoice)
    return status?.problem === UPDATE_PROBLEMS.unknownInstallation ? (
      <SettingRow
        id="update-channel"
        title={UPDATE_WORDS.channel}
        description=""
        control={null}
        error={status.problem}
      />
    ) : null;
  return (
    <SettingRow
      id="update-channel"
      title={UPDATE_WORDS.channel}
      description="Stable follows published releases. Alpha includes early releases. Changing channels never installs an older version."
      error={problem}
      control={
        <GroupedPills<UpdateChannel>
          name={UPDATE_WORDS.channel}
          htmlName="update-channel"
          value={status.channel}
          disabled={status.phase === "installing" || status.phase === "ready"}
          options={[
            { value: "stable", label: "Stable" },
            { value: "alpha", label: "Alpha" },
          ]}
          onChange={(next) => {
            void chooseUpdateChannel(next);
          }}
        />
      }
    />
  );
}
