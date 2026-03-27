import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@retrom/ui/components/dialog";
import { ScrollArea } from "@retrom/ui/components/scroll-area";
import { Tabs, TabsList, TabsTrigger } from "@retrom/ui/components/tabs";
import { Route as RootRoute } from "@/routes/__root";
import { useNavigate } from "@tanstack/react-router";
import { ServerConfigTab } from "./server";
import { ClientConfigTab } from "./client";

export function ConfigModal() {
  const navigate = useNavigate();
  const { configModal } = RootRoute.useSearch();
  type Tab = NonNullable<typeof configModal>["tab"];

  const tabItems: Record<Tab, { value: Tab; name: string }> = {
    server: { value: "server", name: "Server" },
    client: { value: "client", name: "Client" },
  };

  return (
    <Dialog
      modal
      open={!!configModal?.open}
      onOpenChange={(open) => {
        if (!open) {
          navigate({
            to: ".",
            search: (prev) => ({ ...prev, configModal: undefined }),
          }).catch(console.error);
        }
      }}
    >
      <DialogContent className="h-[92dvh] w-[calc(100dvw-1rem)] max-w-none gap-0 overflow-hidden p-0 sm:w-[min(68rem,calc(100dvw-3rem))]">
        <DialogHeader className="mb-0 border-b px-6 pt-6 pb-4">
          <DialogTitle>Retrom Configuration</DialogTitle>

          <DialogDescription>
            This is where you can configure your Retrom settings.
          </DialogDescription>
        </DialogHeader>

        <Tabs
          className="min-h-0 flex-1"
          value={configModal?.tab ?? "server"}
          onValueChange={(tab) => {
            navigate({
              to: ".",
              search: (prev) => ({
                ...prev,
                configModal: { open: true, tab: tab as Tab },
              }),
            }).catch(console.error);
          }}
          orientation="vertical"
        >
          <div className="flex min-h-0 flex-1 flex-col">
            <TabsList className="mx-6 mt-4 flex h-fit gap-2">
              {Object.values(tabItems).map(({ value, name }) => (
                <TabsTrigger
                  key={value}
                  value={value}
                  className="text-md w-full"
                >
                  {name}
                </TabsTrigger>
              ))}
            </TabsList>

            <ScrollArea className="min-h-0 flex-1 px-6 py-4">
              <div className="w-full pr-4">
                <ServerConfigTab />
                <ClientConfigTab />
              </div>
            </ScrollArea>
          </div>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}
