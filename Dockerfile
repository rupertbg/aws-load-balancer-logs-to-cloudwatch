FROM public.ecr.aws/lambda/nodejs:20
COPY src /var/task
WORKDIR /var/task
RUN npm ci
CMD [ "index.handler" ]