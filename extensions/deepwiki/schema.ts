import { StringEnum } from "@earendil-works/pi-ai";
import { type Static, Type } from "typebox";

export const DEEPWIKI_ACTIONS = ["structure", "contents", "question"] as const;

const DeepWikiActionSchema = StringEnum(DEEPWIKI_ACTIONS, {
	description:
		"DeepWiki operation: structure lists documentation topics, contents reads the generated repository wiki, question asks a focused repository question.",
});

export const DeepWikiParamsSchema = Type.Object({
	action: DeepWikiActionSchema,
	repoName: Type.String({
		minLength: 1,
		description: 'GitHub repository in "owner/repo" format, such as "facebook/react".',
	}),
	question: Type.Optional(
		Type.String({
			minLength: 1,
			description: "Required when action is question. The focused repository question to ask DeepWiki.",
		}),
	),
});

export type DeepWikiAction = (typeof DEEPWIKI_ACTIONS)[number];
export type DeepWikiParams = Static<typeof DeepWikiParamsSchema>;
