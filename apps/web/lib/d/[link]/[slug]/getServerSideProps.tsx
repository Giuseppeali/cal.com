import type { EmbedProps } from "app/WithEmbedSSR";
import type { GetServerSidePropsContext } from "next";
import { z } from "zod";

import { getServerSession } from "@calcom/features/auth/lib/getServerSession";
import { getBookingForReschedule, getMultipleDurationValue } from "@calcom/features/bookings/lib/get-booking";
import type { GetBookingType } from "@calcom/features/bookings/lib/get-booking";
import { orgDomainConfig } from "@calcom/features/ee/organizations/lib/orgDomains";
import { shouldHideBrandingForTeamEvent, shouldHideBrandingForUserEvent } from "@calcom/lib/hideBranding";
import { EventRepository } from "@calcom/lib/server/repository/event";
import { UserRepository } from "@calcom/lib/server/repository/user";
import slugify from "@calcom/lib/slugify";
import prisma from "@calcom/prisma";
import { RedirectType } from "@calcom/prisma/enums";

import { getTemporaryOrgRedirect } from "@lib/getTemporaryOrgRedirect";
import type { inferSSRProps } from "@lib/types/inferSSRProps";

export type PageProps = inferSSRProps<typeof getServerSideProps> & EmbedProps;

async function getUserPageProps(context: GetServerSidePropsContext) {
  const session = await getServerSession({ req: context.req });
  const { link, slug } = paramsSchema.parse(context.params);
  const { rescheduleUid, duration: queryDuration } = context.query;
  const { currentOrgDomain, isValidOrgDomain } = orgDomainConfig(context.req);
  const org = isValidOrgDomain ? currentOrgDomain : null;

  const hashedLink = await prisma.hashedLink.findUnique({
    where: {
      link,
    },
    select: {
      eventTypeId: true,
      eventType: {
        select: {
          users: {
            select: {
              username: true,
              profiles: {
                select: {
                  id: true,
                  organizationId: true,
                  username: true,
                },
              },
            },
          },
          team: {
            select: {
              id: true,
              slug: true,
              hideBranding: true,
              parent: {
                select: {
                  hideBranding: true,
                },
              },
            },
          },
        },
      },
    },
  });

  let name: string;
  let hideBranding = false;

  const notFound = {
    notFound: true,
  } as const;

  if (!hashedLink) {
    return notFound;
  }
  const username = hashedLink.eventType.users[0]?.username;
  const profileUsername = hashedLink.eventType.users[0]?.profiles[0]?.username;

  if (hashedLink.eventType.team) {
    name = hashedLink.eventType.team.slug || "";
    hideBranding = shouldHideBrandingForTeamEvent({
      eventTypeId: hashedLink.eventTypeId,
      team: hashedLink.eventType.team,
    });
  } else {
    if (!username) {
      return notFound;
    }

    if (!org) {
      const redirect = await getTemporaryOrgRedirect({
        slugs: [username],
        redirectType: RedirectType.User,
        eventTypeSlug: slug,
        currentQuery: context.query,
      });

      if (redirect) {
        return redirect;
      }
    }

    name = profileUsername || username;

    const userRepo = new UserRepository(prisma);
    const [user] = await userRepo.findUsersByUsername({
      usernameList: [name],
      orgSlug: org,
    });

    if (!user) {
      return notFound;
    }

    hideBranding = shouldHideBrandingForUserEvent({
      eventTypeId: hashedLink.eventTypeId,
      owner: user,
    });
  }

  let booking: GetBookingType | null = null;
  if (rescheduleUid) {
    booking = await getBookingForReschedule(`${rescheduleUid}`, session?.user?.id);
  }

  const isTeamEvent = !!hashedLink.eventType?.team?.id;

  const eventData = await EventRepository.getPublicEvent(
    {
      username: name,
      eventSlug: slug,
      isTeamEvent,
      org,
      fromRedirectOfNonOrgLink: context.query.orgRedirection === "true",
    },
    session?.user?.id
  );

  if (!eventData) {
    return notFound;
  }

  return {
    props: {
      eventData,
      entity: eventData.entity,
      duration: getMultipleDurationValue(
        eventData.metadata?.multipleDuration,
        queryDuration,
        eventData.length
      ),
      durationConfig: eventData.metadata?.multipleDuration ?? [],
      booking,
      user: name,
      slug,
      isBrandingHidden: hideBranding,
      // Sending the team event from the server, because this template file
      // is reused for both team and user events.
      isTeamEvent,
      hashedLink: link,
    },
  };
}

const paramsSchema = z.object({ link: z.string(), slug: z.string().transform((s) => slugify(s)) });

// Booker page fetches a tiny bit of data server side, to determine early
// whether the page should show an away state or dynamic booking not allowed.
export const getServerSideProps = async (context: GetServerSidePropsContext) => {
  return await getUserPageProps(context);
};
