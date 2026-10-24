// A closed vocabulary shared by the mail compiler and the trace store, so one list serves both layers.
export const MAIL_QUERY_OPERATORS = ['from', 'to', 'cc', 'bcc', 'subject', 'after', 'before', 'newer_than', 'older_than', 'is', 'has', 'label', 'in', 'filename', 'larger', 'smaller', 'list', 'deliveredto', 'rfc822msgid'] as const;
