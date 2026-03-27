import { Button } from "@retrom/ui/components/button";
import { FormControl, FormItem, FormLabel } from "@retrom/ui/components/form";
import { Input } from "@retrom/ui/components/input";
import {
  TooltipProvider,
  Tooltip,
  TooltipTrigger,
  TooltipContent,
} from "@retrom/ui/components/tooltip";
import { cn } from "@retrom/ui/lib/utils";
import { useModalAction } from "@/providers/modal-action";
import { FolderOpen } from "lucide-react";
import { useCallback } from "react";
import {
  ControllerFieldState,
  ControllerRenderProps,
  FieldValues,
} from "@retrom/ui/components/form";

export function BrowseButton<T extends FieldValues>(props: {
  field: ControllerRenderProps<T>;
  fieldState: ControllerFieldState;
  dialogTitle?: string;
  dialogDescription?: string;
  label?: string;
  placeholder?: string;
}) {
  const { openModal } = useModalAction("serverFileExplorerModal");
  const {
    field,
    fieldState,
    dialogTitle = "Select Library Path",
    dialogDescription = "Select a directory for this library.",
    label = "Path",
    placeholder = "Select a directory...",
  } = props;

  const browse = useCallback(
    (setValueCallback: (path: string) => void) => {
      openModal({
        title: dialogTitle,
        description: dialogDescription,
        onClose: (path) => {
          if (path) {
            setValueCallback(path);
          }
        },
      });
    },
    [dialogDescription, dialogTitle, openModal],
  );

  return (
    <TooltipProvider>
      <Tooltip>
        <FormItem className="sm:flex sm:items-center sm:gap-2 h-min sm:space-y-0 py-1 relative">
          <FormLabel className="sm:hidden">{label}</FormLabel>

          <div className="flex w-full gap-2 sm:contents">
            <Button
              {...field}
              size="icon"
              type="button"
              className="min-h-0 sm:h-min sm:w-min sm:p-2"
              onClick={() => browse(field.onChange)}
            >
              <FolderOpen className="h-[1rem] w-[1rem]" />
            </Button>

            <TooltipTrigger asChild>
              <FormControl>
                <Input
                  {...field}
                  placeholder={placeholder}
                  className={cn(
                    "text-xs text-muted-foreground transition-colors sm:w-[260px] overflow-hidden text-ellipsis",
                    "sm:border-none font-mono placeholder:italic bg-transparent dark:bg-transparent",
                    fieldState.isDirty && "text-foreground",
                  )}
                />
              </FormControl>
            </TooltipTrigger>
            <TooltipContent hidden={!field.value}>{field.value}</TooltipContent>
          </div>
        </FormItem>
      </Tooltip>
    </TooltipProvider>
  );
}
