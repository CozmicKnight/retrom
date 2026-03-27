import { Button } from "@retrom/ui/components/button";
import { Checkbox } from "@retrom/ui/components/checkbox";
import { DialogFooter } from "@retrom/ui/components/dialog";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
} from "@retrom/ui/components/form";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@retrom/ui/components/table";
import { TabsContent } from "@retrom/ui/components/tabs";
import {
  ContentDirectorySchema,
  MetadataConfigSchema,
  ServerConfig,
  StorageType,
} from "@retrom/codegen/retrom/server/config_pb";
import { useUpdateServerConfig } from "@/mutations/useUpdateServerConfig";
import { zodResolver } from "@hookform/resolvers/zod";
import { useNavigate } from "@tanstack/react-router";
import { Plus, Trash, Undo } from "lucide-react";
import { useCallback } from "react";
import { useFieldArray, useForm } from "@retrom/ui/components/form";
import { z } from "zod";
import { BrowseButton } from "./browse";
import { IgnorePatternsInput, IgnorePatternsTooltip } from "./ignore-patterns";
import { StorageTypeSelect } from "./storage-type";
import {
  CustomLibraryDefinitionInput,
  libraryDefinitionValidator,
} from "./custom-library-definition";
import { InferSchema } from "@/lib/utils";
import { RawMessage } from "@/utils/protos";
import { create } from "@bufbuild/protobuf";
import { cn } from "@retrom/ui/lib/utils";

export const contentDirectorySchema = z.object({
  path: z.string().min(1),
  storageType: z.nativeEnum(StorageType),
  customLibraryDefinition: libraryDefinitionValidator.default({
    definition: "",
  }),
  newly: z.enum(["added", "removed"]).optional(),
  ignorePatterns: z
    .object({
      patterns: z.string().array(),
    })
    .default({ patterns: [] }),
  smartStructureEnabled: z.boolean().default(false),
}) satisfies InferSchema<
  RawMessage<ServerConfig>["contentDirectories"][number]
>;

const librariesSchema = z.object({
  contentDirectories: z.array(
    contentDirectorySchema.refine(
      (value) =>
        !(
          value.storageType === StorageType.CUSTOM &&
          value.customLibraryDefinition.definition === ""
        ),
      {
        message: "Custom library definition cannot be empty",
        path: ["customLibraryDefinition", "definition"],
      },
    ),
  ),
}) satisfies InferSchema<Pick<RawMessage<ServerConfig>, "contentDirectories">>;

export type LibrariesSchema = z.infer<typeof librariesSchema>;
export function LibrariesConfig(props: {
  currentConfig: NonNullable<ServerConfig>;
}) {
  const navigate = useNavigate();
  const { mutateAsync: save, status } = useUpdateServerConfig();

  const form = useForm<LibrariesSchema>({
    resolver: zodResolver(librariesSchema),
    defaultValues: librariesSchema.parse(props.currentConfig),
    mode: "all",
    reValidateMode: "onChange",
  });

  const { append, remove, update } = useFieldArray({
    control: form.control,
    name: "contentDirectories",
  });

  const handleSubmit = useCallback(
    async (values: LibrariesSchema) => {
      const contentDirectories = values.contentDirectories.filter(
        (cd) => cd.newly !== "removed",
      );

      try {
        const smartStructureEnabled = contentDirectories.some(
          (cd) => cd.smartStructureEnabled,
        );
        const next = {
          ...props.currentConfig,
          metadata: create(MetadataConfigSchema, {
            ...props.currentConfig.metadata,
            smartStructureEnabled,
          }),
          contentDirectories: contentDirectories.map((cd) =>
            create(ContentDirectorySchema, {
              ...cd,
              customLibraryDefinition:
                cd.storageType === StorageType.CUSTOM
                  ? cd.customLibraryDefinition
                  : { definition: "" },
            }),
          ),
        };

        const res = await save({ config: next });
        form.reset(librariesSchema.parse(res.configUpdated));
      } catch (error) {
        console.error(error);
        form.reset();
      }
    },
    [form, props.currentConfig, save],
  );

  const isDirty = form.formState.isDirty;
  const isValid = form.formState.isValid;
  const canSubmit = isDirty && isValid && status !== "pending";
  const contentDirectories = form.watch("contentDirectories");
  const showCustomLibraryColumn = contentDirectories.some(
    (library) => library.storageType === StorageType.CUSTOM,
  );

  const action = useCallback(
    (library: (typeof contentDirectories)[number], index: number) => {
      if (library.newly === "added") {
        remove(index);
      } else if (library.newly === "removed") {
        const { newly: _, ...value } = library;
        update(index, value);
      } else {
        update(index, { ...library, newly: "removed" });
      }
    },
    [remove, update],
  );

  return (
    <TabsContent value="contentDirectories">
      <Form {...form}>
        <form
          onSubmit={form.handleSubmit(handleSubmit)}
          className="flex flex-col gap-4"
        >
          <Table className="sm:w-auto">
            <TableHeader>
              <TableRow className="hidden sm:table-row">
                <TableHead>Path</TableHead>
                <TableHead className="w-[1%] whitespace-nowrap">
                  Structure
                </TableHead>
                {showCustomLibraryColumn ? (
                  <TableHead className="w-[1%] whitespace-nowrap">
                    Library Structure
                  </TableHead>
                ) : null}
                <TableHead className="w-[1%] whitespace-nowrap">
                  Rules <IgnorePatternsTooltip />
                </TableHead>
                <TableHead className="w-[1%] whitespace-nowrap text-center">
                  Smart
                </TableHead>
                <TableHead className="w-[1%] whitespace-nowrap" />
              </TableRow>
            </TableHeader>

            <TableBody>
              {contentDirectories.map((library, index) => {
                return (
                  <TableRow
                    key={index}
                    className={cn(
                      "*:py-1 flex flex-col sm:table-row pb-6 sm:pb-0",
                      "sm:*:px-4 *:px-0",
                    )}
                  >
                    <TableCell className="align-middle">
                      <FormField
                        disabled={library.newly === "removed"}
                        control={form.control}
                        name={`contentDirectories.${index}.path` as const}
                        render={BrowseButton}
                      />
                    </TableCell>
                    <TableCell className="w-[1%] whitespace-nowrap align-middle">
                      <FormField
                        disabled={library.newly === "removed"}
                        control={form.control}
                        name={
                          `contentDirectories.${index}.storageType` as const
                        }
                        render={StorageTypeSelect}
                      />
                    </TableCell>
                    {showCustomLibraryColumn ? (
                      <TableCell className="w-[1%] whitespace-nowrap align-middle">
                        <FormField
                          disabled={
                            library.newly === "removed" ||
                            library.storageType !== StorageType.CUSTOM
                          }
                          control={form.control}
                          name={`contentDirectories.${index}.customLibraryDefinition.definition`}
                          render={(props) => (
                            <CustomLibraryDefinitionInput
                              {...props}
                              index={index}
                            />
                          )}
                        />
                      </TableCell>
                    ) : null}
                    <TableCell className="w-[1%] whitespace-nowrap align-middle">
                      <FormField
                        disabled={library.newly === "removed"}
                        control={form.control}
                        name={`contentDirectories.${index}.ignorePatterns.patterns`}
                        render={IgnorePatternsInput}
                      />
                    </TableCell>
                    <TableCell className="w-[1%] whitespace-nowrap align-middle">
                      <FormField
                        disabled={library.newly === "removed"}
                        control={form.control}
                        name={`contentDirectories.${index}.smartStructureEnabled`}
                        render={({ field }) => (
                          <FormItem className="sm:contents sm:space-y-0">
                            <FormLabel className="sm:hidden">Smart</FormLabel>
                            <FormControl>
                              <div className="flex h-full items-center justify-start sm:justify-center">
                                <Checkbox
                                  disabled={field.disabled}
                                  checked={field.value}
                                  onCheckedChange={(checked) =>
                                    field.onChange(checked === true)
                                  }
                                />
                              </div>
                            </FormControl>
                          </FormItem>
                        )}
                      />
                    </TableCell>
                    <TableCell className="w-[1%] whitespace-nowrap text-end align-middle">
                      <Button
                        type="button"
                        size="icon"
                        onClick={() => action(library, index)}
                        variant={library.newly ? "secondary" : "destructive"}
                        className="min-h-0 h-min w-min p-2 hidden sm:flex"
                      >
                        {library.newly ? (
                          <Undo className="h-[1rem] w-[1rem]" />
                        ) : (
                          <Trash className="h-[1rem] w-[1rem]" />
                        )}
                      </Button>

                      <Button
                        type="button"
                        onClick={() => action(library, index)}
                        variant={library.newly ? "secondary" : "destructive"}
                        className="min-h-0 sm:hidden flex gap-2 w-full"
                      >
                        {library.newly ? (
                          <>
                            Undo <Undo className="h-[1rem] w-[1rem]" />
                          </>
                        ) : (
                          <>
                            Delete <Trash className="h-[1rem] w-[1rem]" />
                          </>
                        )}
                      </Button>
                    </TableCell>
                  </TableRow>
                );
              })}

              <TableRow className="*:py-2 border-b-0 sm:*:px-4 *:px-0">
                <TableCell
                  colSpan={showCustomLibraryColumn ? 6 : 5}
                  className="text-end"
                >
                  <Button
                    type="button"
                    size="icon"
                    variant="secondary"
                    className="min-h-0 h-min w-min p-2 hidden sm:flex"
                    onClick={() =>
                      append({
                        newly: "added",
                        path: "",
                        storageType: 0,
                        ignorePatterns: { patterns: [] },
                        customLibraryDefinition: { definition: "" },
                        smartStructureEnabled: false,
                      })
                    }
                  >
                    <Plus className="h-[1rem] w-[1rem]" />
                  </Button>

                  <Button
                    type="button"
                    size="icon"
                    variant="secondary"
                    className="min-h-0 sm:hidden flex gap-2 w-full items-center"
                    onClick={() =>
                      append({
                        newly: "added",
                        path: "",
                        storageType: 0,
                        ignorePatterns: { patterns: [] },
                        customLibraryDefinition: { definition: "" },
                        smartStructureEnabled: false,
                      })
                    }
                  >
                    Add Library <Plus className="h-[1rem] w-[1rem]" />
                  </Button>
                </TableCell>
              </TableRow>
            </TableBody>
          </Table>
        </form>
      </Form>

      <DialogFooter className="gap-2">
        <Button
          onClick={() =>
            navigate({
              to: ".",
              search: (prev) => ({ ...prev, configModal: undefined }),
            })
          }
          variant="secondary"
        >
          Close
        </Button>

        <Button onClick={form.handleSubmit(handleSubmit)} disabled={!canSubmit}>
          Save
        </Button>
      </DialogFooter>
    </TabsContent>
  );
}
